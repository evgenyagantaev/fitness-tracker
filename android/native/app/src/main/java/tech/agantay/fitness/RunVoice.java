package tech.agantay.fitness;

import java.util.ArrayList;
import java.util.List;

/**
 * v1.8: the live run tracker behind the voice announcements. Fed once a second by WorkoutService; decides WHAT to say and WHEN to
 * queue it (VoiceQueue decides when it is actually spoken). Pure Java, no Android classes → unit-tested with simulated runs.
 *
 * Live run state (the same thresholds as the segmentation in analysis.js, but causal):
 *   IDLE   → the approach on foot: nothing is said except «Регистрация бега началась» at Старт;
 *   RUN    → cadence ≥ 135 and speed ≥ 1.7 m/s (or cadence-only / speed-only fall-backs) held for 20 s; the run clock counts here;
 *   PAUSE  → a dog stop: GPS speed (Doppler) < 0.8 m/s for 5 s, or — without GPS — no step events for 14 s. «приостановлена» is spoken at detection (≈15 s after the real stop); the stored pause starts at that real stop. Resume marker is unshifted;
 *   v1.13: with the H10 accelerometer streaming, the strap's real-time steps (one value per second, ~1 s latency) decide instead:
 *            stop = no strap step for STRAP_STILL_S s (spoken ≈4 s after the last step) or walking cadence (< STRAP_WALK_CAD) for
 *            STRAP_WALK_S s; resume = strap cadence ≥ STRAP_RUN_CAD for STRAP_RESUME_S s. GPS can no longer pause a run while the
 *            strap still counts running steps (slow runs at 7–9 min/km hover around the GPS speed thresholds).
 *            Without the strap, the phone step counter (batched every ~10 s on MIUI) gates the GPS rules.
 *   WALK   → 90 s without running (or a 2-minute pause): the run is over or broken off; silent, «возобновлена» when running again.
 * Everything except the start phrase is announced only in RUN (HR thresholds, 2-min summary, distance milestones).
 */
final class RunVoice {
    enum S { IDLE, RUN, PAUSE, WALK }

    static final class Cfg { boolean enabled = true, events = true, hr = true, summary = true, distance = true; }

    static final double RUN_CAD = 135, STRONG_CAD = 150, RUN_SPEED = 1.7, SPEED_ALONE = 2.0;
    static final int START_STREAK_S = 20, WALK_AFTER_S = 90, PAUSE_STILL_S = 5, PAUSE_SPD_WIN = 5, PAUSE_LOOKBACK_S = 25, PAUSE_NOGPS_STALE_S = 14, PAUSE_WALK_S = 120;
    // v1.13: strap (H10 accelerometer) steps
    static final double STRAP_RUN_CAD = 125, STRAP_WALK_CAD = 110, STRAP_STILL_CAD = 40;
    static final int STRAP_LIVE_S = 4, STRAP_STILL_S = 3, STRAP_WALK_S = 10, STRAP_RESUME_S = 2, STRAP_WALK_RESUME_S = 5;
    static final double GPS_RESUME_SPEED = 1.5;   // was 2.0 m/s (8:20 min/km): too close to a slow run's GPS speed
    static final int GPS_PAUSE_MAX_WAIT_S = 12;   // GPS says «still» but the last phone step batch said «running»: wait at most this long
    static final int SUMMARY_EVERY_S = 120, MILESTONE_M = 500, HR_FIRST = 100, HR_STEP = 20, HR_LAST = 220, HR_REARM = 5, LOCK_S = 25;
    static final long TTL_EVENT_MS = 30_000, TTL_HR_MS = 20_000, TTL_SUMMARY_MS = 40_000, TTL_DIST_MS = 60_000;

    final Cfg cfg; final VoiceQueue q;
    S state = S.IDLE;
    int runStartSec = -1, lastRunLikeSec = -1, runClock = 0, pauses = 0, pausedTotal = 0;
    double runStartGps = 0, runStartSteps = 0;
    private int nextSummary = SUMMARY_EVERY_S, lastKm = 0;
    private int runStreak = 0, nonRun = 0, stillStreak = 0, moveStreak = 0, pausedFor = 0, noGpsFor = 0, lockStreak = 0;
    private int pauseStartSec = -1, lastEventTl = -1, lastEventArrival = -1;
    private int strapStill = 0, strapWalk = 0, strapLastRun = -1;
    private int strapLastStep = -1, strapPrevCount = -1;   // last second in which the strap's step count grew (diagnostics)
    private boolean strapWasLive = false;
    boolean strapLive = false; double strapCadNow = Double.NaN;
    private final boolean[] armed;
    private final int[] thresholds;
    /** per second: {sec, gpsDist, stepsDist, 1 if RUN} */
    private final ArrayList<double[]> hist = new ArrayList<>();
    private final ArrayList<Double> spdHist = new ArrayList<>();
    boolean locked = false;
    private final ArrayList<int[]> pauseSpans = new ArrayList<>();
    private int spanStart = 0;
    private int pendingT = 0, pendingSec = 0; private boolean pendingJump = false;
    private final ArrayList<int[]> silentCross = new ArrayList<>();   // thresholds crossed before the run was detected: {sec, T}
    int paceNow = 0, cadNow = 0, hrNow = 0;   // last values (for tests / diagnostics)

    RunVoice(Cfg cfg, VoiceQueue q) {
        this.cfg = cfg; this.q = q;
        int n = (HR_LAST - HR_FIRST) / HR_STEP + 1;
        thresholds = new int[n]; armed = new boolean[n];
        for (int i = 0; i < n; i++) { thresholds[i] = HR_FIRST + i * HR_STEP; armed[i] = true; }
    }

    /** «Старт» of a run (not when the service resumes after the process died) */
    void started(long nowMs) { if (cfg.enabled && cfg.events) q.offer(RunPhrases.started(), VoiceQueue.EVENT, "start", nowMs, TTL_EVENT_MS); }

    // ---- live measurements ----

    /** steps/min from the step events of the last `span` s; 0 when there has been no event for 12 s; NaN with < 2 events. Pairs of events more than 12 s apart (a stop in between) are ignored. */
    static double liveCad(List<int[]> ss, int sec, int span) { return liveCad(ss, sec, span, null); }
    /** excl: stop spans [from, to] — event pairs that touch them are skipped (their steps cover only part of the interval) */
    static double liveCad(List<int[]> ss, int sec, int span, List<int[]> excl) {
        int n = ss.size();
        if (n < 2) return Double.NaN;
        int tl = ss.get(n - 1)[0];
        if (sec - tl >= 12) return 0;
        double steps = 0, dur = 0;
        for (int i = n - 1; i >= 1; i--) {
            int[] b = ss.get(i), a = ss.get(i - 1);
            if (tl - b[0] >= span) break;
            int dt = b[0] - a[0]; if (dt <= 0 || dt > 12) continue;
            if (excl != null) { boolean hit = false; for (int[] x : excl) if (a[0] <= x[1] && b[0] >= x[0]) { hit = true; break; } if (hit) continue; }   // a longer gap is a stop in between: how long they moved inside it is unknown
            steps += b[1] - a[1]; dur += dt;
        }
        return dur > 0 ? steps * 60.0 / dur : Double.NaN;
    }

    /** steps/min of the strap over the last `w` s from the per-second series [sec, cumulative steps]; NaN if the series is stale or too short */
    static double strapCad(List<int[]> st, int sec, int w) {
        if (st == null || st.isEmpty()) return Double.NaN;
        int n = st.size(); int[] last = st.get(n - 1);
        if (sec - last[0] > STRAP_LIVE_S) return Double.NaN;
        int t1 = last[0], s1 = last[1], t0 = -1, s0 = 0;
        for (int i = n - 1; i >= 0; i--) { int[] p = st.get(i); if (p[0] <= t1 - w) { t0 = p[0]; s0 = p[1]; break; } }
        if (t0 < 0 || t1 - t0 > w + 3) return Double.NaN;
        return (s1 - s0) * 60.0 / (t1 - t0);
    }

    private static String fmt(double v) { return Double.isNaN(v) ? "NaN" : String.format(java.util.Locale.ROOT, "%.1f", v); }

    static boolean isRunning(double cad, double spd) {
        boolean hc = !Double.isNaN(cad), hs = !Double.isNaN(spd);
        if (!hc && !hs) return false;
        if (!hc) return spd >= SPEED_ALONE;
        if (!hs) return cad >= RUN_CAD;
        if (cad >= RUN_CAD) return spd >= RUN_SPEED || (cad >= STRONG_CAD && spd >= 0.6);
        return cad >= 100 && spd >= 2.4;
    }

    private double meanLast(int k, int minValid) {
        double s = 0; int c = 0;
        for (int i = spdHist.size() - 1; i >= 0 && i >= spdHist.size() - k; i--) { double v = spdHist.get(i); if (!Double.isNaN(v)) { s += v; c++; } }
        return c >= minValid ? s / c : Double.NaN;
    }
    private double medianLast(int k, int minValid) {
        ArrayList<Double> v = new ArrayList<>();
        for (int i = spdHist.size() - 1; i >= 0 && i >= spdHist.size() - k; i--) if (!Double.isNaN(spdHist.get(i))) v.add(spdHist.get(i));
        if (v.size() < minValid) return Double.NaN;
        java.util.Collections.sort(v); return v.get(v.size() / 2);
    }

    /**
     * Last second in the look-back window whose 5-sample mean speed was still running (≥ RUN_SPEED),
     * plus one: that is where the runner left running pace. Falls back to {@code fallback} when the
     * window has no run-like sample (already standing when the history begins).
     */
    static int truePauseStart(List<Double> spdHist, int sec, int fallback) {
        if (spdHist == null || spdHist.isEmpty()) return fallback;
        int last = spdHist.size() - 1;
        int lo = Math.max(0, last - PAUSE_LOOKBACK_S + 1);
        int lastRun = -1;
        for (int i = lo; i <= last; i++) {
            double s = 0; int c = 0;
            for (int j = Math.max(0, i - PAUSE_SPD_WIN + 1); j <= i; j++) {
                double v = spdHist.get(j);
                if (!Double.isNaN(v)) { s += v; c++; }
            }
            if (c >= 3 && s / c >= RUN_SPEED) lastRun = i;
        }
        if (lastRun < 0) return fallback;
        int start = sec - (last - lastRun) + 1;
        return Math.max(0, Math.min(sec, start));
    }

    /** v1.16: every pause the phone detected live, for the saved record: the closed spans plus a pause still open at `nowSec` (closed at nowSec). */
    int[][] allPauseSpans(int nowSec) {
        ArrayList<int[]> l = new ArrayList<>(pauseSpans);
        if (state == S.PAUSE && spanStart >= 0) l.add(new int[] { spanStart, Math.max(spanStart, nowSec) });
        return l.toArray(new int[0][]);
    }
    /** Closed pause spans [start, end] (start is the real stop, end is already unshifted by the resume streak). */
    int[][] pauseSpans() {
        int[][] a = new int[pauseSpans.size()][];
        for (int i = 0; i < a.length; i++) a[i] = pauseSpans.get(i).clone();
        return a;
    }

    private static double hrAvg(List<int[]> hr, int sec, int span, int minN) {
        if (hr == null) return Double.NaN;
        double s = 0; int c = 0;
        for (int i = hr.size() - 1; i >= 0; i--) {
            int[] p = hr.get(i);
            if (p[0] < sec - span) break;
            if (p[0] > sec) continue;
            if (p[1] >= 30 && p[1] <= 240) { s += p[1]; c++; }
        }
        return c >= minN ? s / c : Double.NaN;
    }

    private double distAt(double t, int idx) {   // idx: 1 = GPS, 2 = steps
        int n = hist.size();
        if (n == 0) return 0;
        if (t <= hist.get(0)[0]) return hist.get(0)[idx];
        if (t >= hist.get(n - 1)[0]) return hist.get(n - 1)[idx];
        int lo = 0, hi = n - 1;
        while (hi - lo > 1) { int m = (lo + hi) >>> 1; if (hist.get(m)[0] <= t) lo = m; else hi = m; }
        double[] a = hist.get(lo), b = hist.get(hi);
        return b[0] == a[0] ? b[idx] : a[idx] + (b[idx] - a[idx]) * (t - a[0]) / (b[0] - a[0]);
    }

    /** HR rose by 40 bpm or more within the last 20 s: a strap that has started to copy the step cadence, not a heart */
    static boolean hrJump(List<int[]> hr, int sec, double hrv) {
        int min = Integer.MAX_VALUE;
        for (int i = hr.size() - 1; i >= 0; i--) { int[] p = hr.get(i); if (p[0] < sec - 20) break; if (p[1] < min) min = p[1]; }
        return min != Integer.MAX_VALUE && hrv - min >= 40;
    }

    // ---- the per-second step ----

    /**
     * @param sec seconds since Старт; ss step events [sec, steps]; hr HR samples [sec, bpm]; gpsSpeed Doppler speed m/s or NaN when there is no fresh fix
     * @param gpsOk the GPS track is good enough to be the distance source
     */
    void tick(int sec, long nowMs, List<int[]> ss, List<int[]> hr, double gpsDist, boolean gpsOk, double gpsSpeed, int steps, double stride, boolean hasStrap) {
        tick(sec, nowMs, ss, hr, gpsDist, gpsOk, gpsSpeed, steps, stride, hasStrap, null);
    }

    /** @param strap the H10's real-time steps, one point per second [sec, cumulative steps]; null / stale = no strap steps */
    void tick(int sec, long nowMs, List<int[]> ss, List<int[]> hr, double gpsDist, boolean gpsOk, double gpsSpeed, int steps, double stride, boolean hasStrap, List<int[]> strap) {
        if (!cfg.enabled) return;
        double sc3 = strapCad(strap, sec, 3), sc4 = strapCad(strap, sec, 4), sc8 = strapCad(strap, sec, 8);
        strapLive = !Double.isNaN(sc4);
        strapCadNow = strapLive ? strapCad(strap, sec, 30) : Double.NaN;
        if (strap != null && !strap.isEmpty()) {   // diagnostics: when did the strap last count a step, and did its feed go stale
            int cnt = strap.get(strap.size() - 1)[1];
            if (strapPrevCount >= 0 && cnt > strapPrevCount) strapLastStep = sec;
            strapPrevCount = cnt;
        }
        if (state != S.IDLE && strapLive != strapWasLive) {
            EventLog.add(strapLive ? "strap live again" : "strap feed stale (no strap point for >" + STRAP_LIVE_S + " s) state=" + state);
        }
        strapWasLive = strapLive;
        double[] last = hist.isEmpty() ? null : hist.get(hist.size() - 1);
        // seconds of actual running inside the run (the live pace is distance over these seconds only)
        boolean mv = strapLive ? state == S.RUN && sc4 >= STRAP_WALK_CAD
            : Double.isNaN(gpsSpeed) ? state == S.RUN : state == S.RUN && gpsSpeed >= 0.8;
        double[] h = { sec, gpsDist, steps * stride, mv ? 1 : 0 };
        if (last != null && last[0] >= sec) hist.set(hist.size() - 1, h); else hist.add(h);
        spdHist.add(gpsSpeed);
        if (spdHist.size() > 40) spdHist.remove(0);

        int nEv = ss.size();
        int tl = nEv > 0 ? ss.get(nEv - 1)[0] : -1;
        if (tl != lastEventTl) { lastEventTl = tl; lastEventArrival = sec; }
        double cad30 = liveCad(ss, sec, 30), cad20 = liveCad(ss, sec, 20);
        double spd10 = medianLast(10, 5), spd5 = meanLast(5, 3), spd3 = meanLast(3, 2);
        boolean gpsFresh = !Double.isNaN(spd5) || !Double.isNaN(spd3);
        if (gpsFresh) noGpsFor = 0; else noGpsFor++;
        boolean runLike = isRunning(cad20, spd10);
        double hrv = hasStrap ? hrAvg(hr, sec, 5, 3) : Double.NaN;
        hrNow = Double.isNaN(hrv) ? 0 : (int) Math.round(hrv);
        if (strapLive && !Double.isNaN(strapCadNow)) cad30 = strapCadNow;   // the strap counts every step, the phone batches them
        cadNow = Double.isNaN(cad30) ? 0 : (int) Math.round(cad30);
        if (strapLive) {
            strapStill = sc3 < STRAP_STILL_CAD ? strapStill + 1 : 0;
            strapWalk = sc8 < STRAP_WALK_CAD ? strapWalk + 1 : 0;
            if (sc4 >= STRAP_RUN_CAD) strapLastRun = sec;
            // the strap decides; GPS only vetoes running in place (≥ 10 s of GPS standstill)
            boolean inPlace = !Double.isNaN(spd10) && spd10 < 0.5;
            runLike = sc8 >= STRAP_RUN_CAD && !inPlace;
        } else { strapStill = 0; strapWalk = 0; }

        switch (state) {
            case IDLE: case WALK:
                runStreak = runLike ? runStreak + 1 : 0;
                if (runStreak >= (state == S.WALK && strapLive ? STRAP_WALK_RESUME_S : START_STREAK_S)) {
                    EventLog.add((state == S.IDLE ? "run start" : "run again after WALK") + " sc8=" + fmt(sc8) + " strapLive=" + strapLive);
                    if (state == S.IDLE) {
                        state = S.RUN; runStartSec = Math.max(0, sec - START_STREAK_S); runClock = Math.min(sec, START_STREAK_S);
                        runStartGps = distAt(runStartSec, 1); runStartSteps = distAt(runStartSec, 2);
                        int best = 0; for (int[] c : silentCross) if (c[0] >= runStartSec && c[1] > best) best = c[1];
                        if (best > 0 && cfg.hr && !locked) {
                            if (hrJump(hr, sec, hrv)) { pendingT = best; pendingSec = sec; pendingJump = true; }   // wait: see the HR block below
                            else q.offer(RunPhrases.hrOver(best), VoiceQueue.EVENT, "hr", nowMs, TTL_HR_MS);
                        }
                    } else {
                        state = S.RUN;
                        if (cfg.events) q.offer(RunPhrases.resumed(), VoiceQueue.EVENT, "resume", nowMs, TTL_EVENT_MS);
                    }
                    nonRun = 0; stillStreak = 0; lastRunLikeSec = sec; runStreak = 0; strapStill = 0; strapWalk = 0;
                }
                break;
            case RUN: {
                runClock++;
                if (runLike) { lastRunLikeSec = sec; nonRun = 0; } else nonRun++;
                boolean gpsStill = !Double.isNaN(spd5) && spd5 < 0.8;
                boolean stepStill = noGpsFor >= 10 && nEv >= 2 && sec - lastEventArrival >= PAUSE_NOGPS_STALE_S && sec - tl >= 12;
                stillStreak = gpsStill ? stillStreak + 1 : 0;
                boolean pause;
                if (strapLive) pause = strapStill >= STRAP_STILL_S || strapWalk >= STRAP_WALK_S;
                else {
                    // the last phone step batch (≈ every 10 s) still said «running»: GPS alone waits a bit longer before it pauses
                    boolean phoneRan = nEv >= 2 && sec - lastEventArrival <= 11 && lastPairCad(ss) >= 120;
                    pause = (stillStreak >= PAUSE_STILL_S && (!phoneRan || stillStreak >= GPS_PAUSE_MAX_WAIT_S)) || stepStill;
                }
                if (pause) {
                    String cause = strapLive ? (strapStill >= STRAP_STILL_S ? "strap-still " + strapStill + "s" : "strap-walk-cadence " + strapWalk + "s") : stepStill ? "phone-steps-stale" : "gps-still " + stillStreak + "s";
                    EventLog.add("PAUSE decided: " + cause + " lastStrapStep=" + (strapLastStep >= 0 ? (sec - strapLastStep) + "s ago" : "n/a") + " sc3=" + fmt(sc3) + " sc8=" + fmt(sc8)
                        + " gpsSpd5=" + fmt(spd5) + " strapLive=" + strapLive);
                    state = S.PAUSE; pauses++; pauseStartSec = sec;
                    // the phrase is queued at detection time (it cannot be earlier); the stored span starts at the real stop
                    int fallback = Math.max(0, sec - PAUSE_STILL_S - PAUSE_SPD_WIN);
                    spanStart = strapLive ? Math.max(runStartSec, Math.min(sec, strapLastRun >= 0 ? strapLastRun + 1 : fallback))
                        : stepStill && stillStreak < PAUSE_STILL_S ? tl : truePauseStart(spdHist, sec, fallback);
                    strapStill = 0; strapWalk = 0;
                    pausedFor = 0; moveStreak = 0; stillStreak = 0;
                    if (cfg.events) q.offer(RunPhrases.paused(), VoiceQueue.EVENT, "pause", nowMs, TTL_EVENT_MS);
                } else if (nonRun >= WALK_AFTER_S) { EventLog.add("RUN -> WALK (" + nonRun + "s not running)"); state = S.WALK; runStreak = 0; }
                break;
            }
            case PAUSE: {
                pausedFor++; pausedTotal++;
                boolean moving, phoneRuns = lastEventArrival > pauseStartSec && lastPairCad(ss) >= 125;
                int need;
                if (strapLive) { moving = sc3 >= STRAP_RUN_CAD; need = STRAP_RESUME_S; }
                else if (!Double.isNaN(spd3)) { moving = spd3 >= GPS_RESUME_SPEED || (phoneRuns && spd3 >= 1.0); need = 3; }
                else { moving = noGpsFor >= 3 && lastEventArrival > pauseStartSec && !Double.isNaN(cad20) && cad20 >= 100; need = 1; }
                moveStreak = moving ? moveStreak + 1 : 0;
                if (moveStreak >= need) {
                    EventLog.add("RESUME decided: moving " + moveStreak + "s sc3=" + fmt(sc3) + " strapLive=" + strapLive + " after " + pausedFor + "s");
                    pauseSpans.add(new int[] { spanStart, Math.max(spanStart, sec - moveStreak) }); if (pauseSpans.size() > 200) pauseSpans.remove(0);
                    state = S.RUN; nonRun = 0; stillStreak = 0; lastRunLikeSec = sec; strapStill = 0; strapWalk = 0;
                    if (cfg.events) q.offer(RunPhrases.resumed(), VoiceQueue.EVENT, "resume", nowMs, TTL_EVENT_MS);
                } else if (pausedFor >= PAUSE_WALK_S) {
                    pauseSpans.add(new int[] { spanStart, sec }); if (pauseSpans.size() > 200) pauseSpans.remove(0);   // a pause that turned into walking is still a pause
                    EventLog.add("PAUSE -> WALK after " + pausedFor + "s");
                    state = S.WALK; runStreak = 0;
                }
                break;
            }
        }

        // HR thresholds: armed / disarmed in every state; thresholds crossed in the 20 s before the run was recognised are announced when it is,
        // the ones crossed during the approach are not. Crossings close to the cadence are held back 28 s: a strap that copies the cadence is unmasked by then.
        if (!Double.isNaN(hrv)) {
            if (!Double.isNaN(cad30) && cad30 >= 100 && Math.abs(hrv - cad30) <= 2) lockStreak++;
            else if (Double.isNaN(cad30) || Math.abs(hrv - cad30) >= 8) lockStreak = 0;
            else lockStreak = Math.max(0, lockStreak - 1);
            locked = lockStreak >= LOCK_S;   // the strap counts steps instead of beats: HR within ±2 of the cadence for 25 s
            int crossed = -1;
            for (int i = 0; i < thresholds.length; i++) {
                if (armed[i] && hrv >= thresholds[i]) { crossed = thresholds[i]; armed[i] = false; }
                else if (!armed[i] && hrv <= thresholds[i] - HR_REARM) armed[i] = true;
            }
            if (crossed > 0) {
                if (state != S.RUN) silentCross.add(new int[] { sec, crossed });
                else if (!locked && cfg.hr) {
                    boolean near = !Double.isNaN(cad30) && cad30 >= 100 && Math.abs(hrv - cad30) <= 8;
                    boolean jump = hrJump(hr, sec, hrv);   // +40 bpm in 20 s is not a heart: wait and see whether it still copies the cadence
                    if (near || jump) { pendingT = crossed; pendingSec = sec; pendingJump = jump; }
                    else { pendingT = 0; q.offer(RunPhrases.hrOver(crossed), VoiceQueue.EVENT, "hr", nowMs, TTL_HR_MS); }
                }
            }
            if (pendingT > 0) {
                if (locked || state != S.RUN || hrv < pendingT - HR_REARM) pendingT = 0;
                else if (sec - pendingSec >= LOCK_S + 8) { boolean copies = pendingJump && !Double.isNaN(cad30) && Math.abs(hrv - cad30) <= 8; if (cfg.hr && !copies) q.offer(RunPhrases.hrOver(pendingT), VoiceQueue.EVENT, "hr", nowMs, TTL_HR_MS); pendingT = 0; }
            }
        }
        if (state != S.RUN || sec - lastRunLikeSec > 10) return;   // not while walking home: milestones and summaries only while running

        // distance milestones of the RUN (not of the approach)
        boolean useGps = gpsOk && gpsDist >= 50;
        double runDist = useGps ? gpsDist - runStartGps : steps * stride - runStartSteps;
        int km = (int) Math.floor(runDist / MILESTONE_M);
        if (km > lastKm) {
            lastKm = km;
            if (cfg.distance) q.offer(RunPhrases.distance(km * MILESTONE_M), VoiceQueue.REGULAR, "dist", nowMs, TTL_DIST_MS);
        }
        // every 2 min of running: pulse, cadence, pace from smoothed live values; unavailable items are skipped
        if (runClock >= nextSummary) {
            nextSummary = (runClock / SUMMARY_EVERY_S + 1) * SUMMARY_EVERY_S;
            if (cfg.summary) {
                double hr30 = hasStrap && !locked ? hrAvg(hr, sec, 30, 15) : Double.NaN;
                double c = strapLive ? strapCad(strap, sec, 20) : liveCad(ss, sec, 40, pauseSpans);
                int pace = paceOver(sec, 90, useGps);
                paceNow = pace;
                String t = RunPhrases.summary(Double.isNaN(hr30) ? 0 : (int) Math.round(hr30), Double.isNaN(c) || c < 60 ? 0 : (int) Math.round(c), pace);
                if (!t.isEmpty()) q.offer(t, VoiceQueue.REGULAR, "summary", nowMs, TTL_SUMMARY_MS);
            }
        }
    }

    /** steps/min of the last pair of phone step events (one MIUI batch ≈ 10 s); 0 when unknown */
    static double lastPairCad(List<int[]> ss) {
        int n = ss == null ? 0 : ss.size();
        if (n < 2) return 0;
        int[] b = ss.get(n - 1), a = ss.get(n - 2);
        int dt = b[0] - a[0];
        return dt > 0 && dt <= 15 ? (b[1] - a[1]) * 60.0 / dt : 0;
    }

    /**
     * pace over the last `win` s: distance covered in the running seconds only, divided by those seconds (a stop or a not yet
     * recognised restart inside the window neither slows it down nor speeds it up); 0 = unknown
     */
    private int paceOver(int sec, int win, boolean useGps) {
        int idx = useGps ? 1 : 2;
        double d = 0, moving = 0;
        double[] prev = null;
        for (double[] p : hist) {
            if (p[0] <= sec - win - 1) { prev = p; continue; }
            if (p[0] > sec) break;
            if (prev != null && p[3] > 0 && p[0] - prev[0] <= 3) { d += Math.max(0, p[idx] - prev[idx]); moving += p[0] - prev[0]; }
            prev = p;
        }
        if (d < 60 || moving < 45) return 0;
        int p = (int) Math.round(moving / (d / 1000.0));
        return p >= 150 && p <= 1200 ? p : 0;
    }

    // ---- results for the end of the run (approximate; the app passes the exact numbers of the saved record when it can) ----
    boolean ran() { return runStartSec >= 0; }
    int approxRunEnd() { return lastRunLikeSec >= 0 ? lastRunLikeSec + 10 : runStartSec; }
    int approxMovingS() { return ran() ? Math.max(0, approxRunEnd() - runStartSec - pausedTotal) : 0; }
    double approxDistM(boolean useGps) {
        if (!ran()) return 0;
        int idx = useGps ? 1 : 2;
        return Math.max(0, distAt(approxRunEnd(), idx) - (useGps ? runStartGps : runStartSteps));
    }
}
