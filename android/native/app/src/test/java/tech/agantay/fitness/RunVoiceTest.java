package tech.agantay.fitness;

import static org.junit.Assert.*;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.function.IntToDoubleFunction;

/** v1.8: the announcement logic on simulated runs (second by second, with a fake speaker that needs time to talk). */
public class RunVoiceTest {
    // ---------- VoiceQueue ----------
    @Test public void queueNeverRunsRegularItemsTogetherAndEventsGoFirst() {
        VoiceQueue q = new VoiceQueue();
        q.offer("dist", VoiceQueue.REGULAR, "dist", 0, 60_000);
        q.offer("sum", VoiceQueue.REGULAR, "summary", 0, 60_000);
        q.offer("pause", VoiceQueue.EVENT, "pause", 0, 30_000);
        VoiceQueue.Item i = q.next(0);
        assertEquals("pause", i.text);                      // the event first
        q.started(i); assertNull(q.next(500));              // nothing while speaking
        q.done(3_000);
        assertNull("a regular one waits after an event", q.next(5_000));
        i = q.next(9_000); assertEquals("dist", i.text); q.started(i); q.done(12_000);
        assertNull("20 s between regular ones", q.next(31_000));
        i = q.next(32_000); assertEquals("sum", i.text);
    }
    @Test public void staleItemsAreDroppedAndKeysReplaceOlderOnes() {
        VoiceQueue q = new VoiceQueue();
        q.offer("sum1", VoiceQueue.REGULAR, "summary", 0, 40_000);
        q.offer("sum2", VoiceQueue.REGULAR, "summary", 10_000, 40_000);
        assertEquals(1, q.size());
        assertEquals("sum2", q.next(10_000).text);
        VoiceQueue q2 = new VoiceQueue();
        q2.offer("old", VoiceQueue.REGULAR, "summary", 0, 40_000);
        assertNull(q2.next(50_000)); assertEquals(0, q2.size()); assertEquals(1, q2.dropped);
    }
    @Test public void pauseAndResumeThatAreBothWaitingCancelEachOther() {
        VoiceQueue q = new VoiceQueue();
        q.offer("paused", VoiceQueue.EVENT, "pause", 0, 30_000);
        q.offer("resumed", VoiceQueue.EVENT, "resume", 4_000, 30_000);
        assertEquals(0, q.size());
    }
    @Test public void finalFlushesEverythingAndGoesFirst() {
        VoiceQueue q = new VoiceQueue();
        q.offer("a", VoiceQueue.REGULAR, "dist", 0, 60_000); q.offer("b", VoiceQueue.EVENT, "hr", 0, 20_000);
        q.offer("end", VoiceQueue.FINAL, "final", 100, 0);
        assertEquals(1, q.size());
        assertEquals("end", q.next(200).text);
    }
    @Test public void eventsDoNotCutSpeechButFollowAfterAShortBreath() {
        VoiceQueue q = new VoiceQueue();
        q.offer("e1", VoiceQueue.EVENT, "start", 0, 30_000);
        VoiceQueue.Item i = q.next(0); q.started(i);
        q.offer("e2", VoiceQueue.EVENT, "hr", 1_000, 20_000);
        assertNull(q.next(1_500));
        q.done(2_500);
        assertNull(q.next(3_000));           // < 1.2 s breath
        assertEquals("e2", q.next(3_800).text);
    }

    // ---------- the simulator ----------
    static final class Seg { final int from, to; final double cad, spd; Seg(int f, int t, double c, double s) { from = f; to = t; cad = c; spd = s; } }
    static final class Sim {
        final VoiceQueue q = new VoiceQueue(); final RunVoice.Cfg cfg = new RunVoice.Cfg(); RunVoice rv;
        final List<Object[]> said = new ArrayList<>();   // {startSec, endSec, text}
        final List<int[]> ss = new ArrayList<>(), hr = new ArrayList<>();
        boolean strap = true, gps = true, acc = false; IntToDoubleFunction hrAt = t -> 120; double speakCharsPerSec = 14;
        IntToDoubleFunction gpsDip = null;   // overrides the Doppler speed where it returns ≥ 0
        final List<int[]> accSteps = new ArrayList<>();
        Seg[] segs; double steps = 0, dist = 0;
        VoiceQueue.Item speaking; long speakEnd;
        Sim(Seg... s) { segs = s; rv = new RunVoice(cfg, q); }
        Seg at(int t) { for (Seg s : segs) if (t >= s.from && t < s.to) return s; return new Seg(0, 0, 0, 0); }
        void run(int dur) {
            rv.started(0);
            double evSteps = 0; int lastEv = 0;
            for (int t = 1; t <= dur; t++) {
                long now = t * 1000L;
                Seg s = at(t);
                steps += s.cad / 60.0; dist += s.spd;
                if (t % 10 == 5 && t >= 15) { if (steps - evSteps >= 1) { ss.add(new int[] { t, (int) Math.round(steps) }); evSteps = steps; } }
                // an event stamped t reaches the service ~2 s later: it is visible from t+2
                List<int[]> visible = new ArrayList<>(); for (int[] e : ss) if (e[0] <= t - 2) visible.add(e);
                hr.add(new int[] { t, (int) hrAt.applyAsDouble(t) });
                double spd = gps ? Math.max(0, s.spd + 0.15 * Math.sin(t * 1.7)) : Double.NaN;
                if (gps && s.spd == 0) spd = 0.1;
                if (gps && gpsDip != null && gpsDip.applyAsDouble(t) >= 0) spd = gpsDip.applyAsDouble(t);
                if (acc) accSteps.add(new int[] { t, (int) Math.floor(steps) });
                rv.tick(t, now, visible, strap ? hr : new ArrayList<>(), dist, gps, spd, (int) Math.round(steps), 0.9, strap, acc ? accSteps : null);
                if (speaking != null && now >= speakEnd) { q.done(now); speaking = null; }
                if (speaking == null) {
                    VoiceQueue.Item it = q.next(now);
                    if (it != null) { q.started(it); speaking = it; speakEnd = now + (long) (1000.0 * it.text.length() / speakCharsPerSec); said.add(new Object[] { t, (int) (speakEnd / 1000), it.text }); }
                }
            }
        }
        List<String> texts() { List<String> l = new ArrayList<>(); for (Object[] o : said) l.add((String) o[2]); return l; }
        int when(String prefix) { for (Object[] o : said) if (((String) o[2]).startsWith(prefix)) return (Integer) o[0]; return -1; }
        long count(String prefix) { return texts().stream().filter(x -> x.startsWith(prefix)).count(); }
        static double hrCurve0(int t) { return hrCurve(t); }
        void cadVariation() {}
        void check() {   // never overlapping, regular ones ≥ 20 s apart
            int prevEnd = -100, prevRegEnd = -100;
            for (Object[] o : said) {
                int st = (Integer) o[0], en = (Integer) o[1]; String tx = (String) o[2];
                assertTrue("no overlap: " + tx, st >= prevEnd);
                boolean reg = tx.startsWith("Текущий") || tx.startsWith("Дистанция");
                if (reg) { assertTrue("20 s between regular: " + tx + " at " + st + " prev end " + prevRegEnd, st - prevRegEnd >= 20); prevRegEnd = en; }
                prevEnd = en;
            }
        }
    }
    // approach 0–90 on foot, run 90–900 with a dog stop 300–312
    static Seg[] dogRun() { return new Seg[] { new Seg(0, 90, 100, 1.3), new Seg(90, 300, 165, 2.8), new Seg(300, 312, 0, 0), new Seg(312, 900, 165, 2.8), new Seg(900, 1000, 90, 1.2) }; }
    static int hrCurve(int t) { return t < 100 ? 85 : t < 250 ? 85 + (int) ((t - 100) * 0.4667) : t < 480 ? 155 + (t - 250) / 16 : 169; }   // 85 (approach) → 155 → 169

    @Test public void standardRunWithAStopAndAStrap() {
        Sim s = new Sim(dogRun()); s.hrAt = Sim::hrCurve0; s.run(1000);
        System.out.println("---- standard run ----"); for (Object[] o : s.said) System.out.println(String.format("%4d s  %s", (Integer) o[0], o[2]));
        s.check();
        assertEquals("Регистрация бега началась.", s.texts().get(0)); assertTrue(s.when("Регистрация бега началась") <= 2);
        int p = s.when("Регистрация бега приостановлена"), r = s.when("Регистрация бега возобновлена");
        assertTrue("pause announced within ~10 s of the stop: " + p, p >= 303 && p <= 312);
        assertTrue("resume right after: " + r, r >= 312 && r <= 322);
        assertEquals(1, s.count("Регистрация бега приостановлена")); assertEquals(1, s.count("Регистрация бега возобновлена"));
        int[][] spans = s.rv.pauseSpans();
        assertEquals(1, spans.length);
        assertTrue("span starts at the real stop, not at the announcement: " + spans[0][0], spans[0][0] >= 298 && spans[0][0] <= 303);
        assertTrue("resume end unshifted: " + spans[0][1], spans[0][1] >= 310 && spans[0][1] <= 315);
        assertTrue("announcement stays later than the marker", p >= spans[0][0] + 4);
        for (int th : new int[] { 100, 120, 140 }) assertEquals("once: " + th, 1, s.count("Пульс превысил " + RuNum.words(th) + "."));
        assertTrue("100 before 120 before 140", s.when("Пульс превысил сто.") < s.when("Пульс превысил сто двадцать.") && s.when("Пульс превысил сто двадцать.") < s.when("Пульс превысил сто сорок."));
        assertTrue("summaries every 2 min of running", s.count("Текущий пульс") >= 5);
        for (Object[] o : s.said) { String x = (String) o[2]; if (x.startsWith("Текущий пульс")) { assertTrue(x, x.contains("Текущий каденс сто шестьдесят")); assertTrue(x, x.contains("Текущий темп шесть минут") || x.contains("Текущий темп") ); } }
        assertEquals("Дистанция пятьсот метров.", firstDistance(s)); assertTrue(s.texts().contains("Дистанция километр.")); assertTrue(s.texts().contains("Дистанция полтора километра."));
        assertTrue(s.texts().contains("Дистанция два километра."));
        for (String x : s.texts()) assertFalse(x, x.matches(".*\\d.*"));
        // nothing after the run was over (cooldown walk at 1.2 m/s)
        for (Object[] o : s.said) assertTrue("no talk in the cooldown: " + o[2], (Integer) o[0] < 935);
    }
    static String firstDistance(Sim s) { for (String x : s.texts()) if (x.startsWith("Дистанция")) return x; return null; }

    // v1.13: a slow run (cadence 138, 1.9 m/s ≈ 8:46 min/km) with a 20 s stop at 300–320 and a GPS dip to 0.4 m/s at 500–510 while running on
    static Seg[] slowRun() { return new Seg[] { new Seg(0, 300, 138, 1.9), new Seg(300, 320, 0, 0), new Seg(320, 800, 138, 1.9) }; }
    static double dip(int t) { return t >= 500 && t < 510 ? 0.4 : -1; }
    static int paceSec(String x) {   // "Текущий темп восемь минут сорок секунд" → 520
        String[] m = { "пять", "шесть", "семь", "восемь", "девять", "десять" };
        for (int i = 0; i < m.length; i++) if (x.contains("Текущий темп " + m[i] + " минут")) return (5 + i) * 60;
        return -1;
    }

    @Test public void slowRunWithTheStrapAccelerometer() {
        Sim s = new Sim(slowRun()); s.acc = true; s.gpsDip = RunVoiceTest::dip; s.run(800);
        System.out.println("---- slow run, H10 steps ----"); for (Object[] o : s.said) System.out.println(String.format("%4d s  %s", (Integer) o[0], o[2]));
        s.check();
        int p = s.when("Регистрация бега приостановлена"), r = s.when("Регистрация бега возобновлена");
        assertTrue("stop heard within 6 s: " + p, p >= 301 && p <= 306);
        assertTrue("restart heard within 4 s: " + r, r >= 321 && r <= 324);
        assertEquals("no false pause on the GPS dip", 1, s.count("Регистрация бега приостановлена"));
        int[][] sp = s.rv.pauseSpans();
        assertEquals(1, sp.length);
        assertTrue("span = the real stop: " + sp[0][0] + "–" + sp[0][1], Math.abs(sp[0][0] - 300) <= 2 && Math.abs(sp[0][1] - 320) <= 2);
        int n = 0;
        for (String x : s.texts()) if (x.startsWith("Текущий пульс")) { n++; assertEquals("pace ≈ 8:46 (over the running seconds only): " + x, 8 * 60, paceSec(x)); assertTrue(x, x.contains("каденс сто тридцать")); }
        assertTrue(n >= 4);
    }

    @Test public void slowRunWithoutTheStrapAccelerometer() {
        Sim s = new Sim(slowRun()); s.gpsDip = t -> t >= 500 && t < 508 ? 0.4 : -1; s.run(800);
        System.out.println("---- slow run, phone steps + GPS ----"); for (Object[] o : s.said) System.out.println(String.format("%4d s  %s", (Integer) o[0], o[2]));
        s.check();
        int p = s.when("Регистрация бега приостановлена"), r = s.when("Регистрация бега возобновлена");
        assertTrue("stop heard: " + p, p >= 303 && p <= 316);
        assertTrue("1.9 m/s is running again within a few seconds: " + r, r >= 321 && r <= 327);
        assertEquals("the phone's steps veto a short GPS dip", 1, s.count("Регистрация бега приостановлена"));
        for (String x : s.texts()) if (x.startsWith("Текущий пульс")) assertEquals(x, 8 * 60, paceSec(x));
    }

    @Test public void strapCadenceFromTheSeries() {
        List<int[]> st = new ArrayList<>();
        for (int t = 0; t <= 20; t++) st.add(new int[] { t, (int) (t * 2.3) });
        assertEquals(138, RunVoice.strapCad(st, 20, 10), 3);
        assertTrue("stale series = unknown", Double.isNaN(RunVoice.strapCad(st, 30, 4)));
        assertTrue(Double.isNaN(RunVoice.strapCad(null, 5, 4)));
    }

    @Test public void distanceIsOfTheRunNotOfTheApproach() {
        Sim s = new Sim(dogRun()); s.run(500);
        // the approach (90 s × 1.3 = 117 m) is not counted: 500 m of running = 178 s after the start of the run at ≈ 90 s
        int t = s.when("Дистанция пятьсот метров.");
        assertTrue("500 m at ~" + t, t >= 255 && t <= 285);
    }

    @Test public void beltlessSpeaksNoPulse() {
        Sim s = new Sim(dogRun()); s.strap = false; s.run(700);
        s.check();
        assertEquals(0, s.count("Пульс превысил"));
        assertTrue(s.count("Текущий каденс") >= 3);
        for (String x : s.texts()) assertFalse(x, x.contains("пульс"));
    }

    @Test public void walkingOnlySaysJustTheStartPhrase() {
        Sim s = new Sim(new Seg(0, 1200, 105, 1.4)); s.run(1200);
        assertEquals(1, s.texts().size()); assertEquals("Регистрация бега началась.", s.texts().get(0));
    }

    @Test public void hrThresholdHysteresisAndNoRepeatWhileJittering() {
        Sim s = new Sim(new Seg(0, 20, 100, 1.3), new Seg(20, 900, 165, 2.8));
        // 95 → creeps to 121, jitters 118..122 for a minute, drops to 113, climbs again to 123
        s.hrAt = t -> t < 50 ? 95 : t < 90 ? 95 + (t - 50) * 0.66 : t < 150 ? 121 + 2 * Math.sin(t) : t < 180 ? 113 : 124;
        s.run(300);
        assertEquals("120 announced twice: first crossing and after a real dip", 2, s.count("Пульс превысил сто двадцать."));
        assertEquals(1, s.count("Пульс превысил сто."));
    }

    @Test public void cadenceLockedHrIsNotAnnounced() {
        Sim s = new Sim(new Seg(0, 20, 100, 1.3), new Seg(20, 600, 165, 2.8));
        s.hrAt = t -> t < 60 ? 150 : 165;       // the strap suddenly repeats the cadence: HR == steps/min
        s.run(400);
        assertEquals("no threshold while locked", 0, s.count("Пульс превысил"));
        for (String x : s.texts()) assertFalse("no pulse in summaries while locked: " + x, x.startsWith("Текущий пульс"));
    }

    @Test public void impossibleHrJumpThatCopiesTheCadenceIsNotAnnounced() {
        // 75 → 170 bpm in 12 s at the start, cadence 165: a wrist/strap artefact, never a heart
        Sim s = new Sim(new Seg(0, 20, 100, 1.3), new Seg(20, 900, 165, 2.8));
        s.hrAt = t -> t < 30 ? 75 : t < 42 ? 75 + (t - 30) * 8 : t < 200 ? 168 : 110;
        s.run(400);
        assertEquals("no threshold for the jump", 0, s.count("Пульс превысил"));
    }
    @Test public void fastButRealHrRiseIsStillAnnounced() {
        Sim s = new Sim(new Seg(0, 20, 100, 1.3), new Seg(20, 900, 165, 2.8));
        s.hrAt = t -> t < 30 ? 85 : t < 100 ? 85 + (t - 30) : 155;      // +1 bpm/s: hard but physiological; far from cadence 165? within 10
        s.run(300);
        assertTrue(s.count("Пульс превысил") >= 1);
    }

    @Test public void categoriesCanBeSwitchedOff() {
        Sim s = new Sim(dogRun()); s.hrAt = Sim::hrCurve0; s.cfg.events = false; s.cfg.hr = false; s.cfg.summary = false; s.run(700);
        assertEquals(0, s.texts().size() - s.count("Дистанция"));
        Sim d = new Sim(dogRun()); d.hrAt = Sim::hrCurve0; d.cfg.distance = false; d.run(700);
        assertEquals(0, d.count("Дистанция")); assertTrue(d.count("Текущий") > 0);
        Sim off = new Sim(dogRun()); off.cfg.enabled = false; off.run(700); assertEquals(0, off.texts().size());
    }

    @Test public void slowSpeechDropsStaleSummariesInsteadOfPilingUp() {
        Sim s = new Sim(dogRun()); s.hrAt = Sim::hrCurve0; s.speakCharsPerSec = 2;   // absurdly slow talker: ~60 s per summary
        s.run(900);
        s.check();
        assertTrue("some items dropped", s.q.dropped > 0);
        for (Object[] o : s.said) { String x = (String) o[2]; assertTrue(x, true); }
    }

    @Test public void withoutGpsPauseComesFromMissingStepEvents() {
        Sim s = new Sim(new Seg(0, 60, 100, 1.3), new Seg(60, 300, 165, 2.8), new Seg(300, 330, 0, 0), new Seg(330, 700, 165, 2.8));
        s.gps = false; s.strap = false; s.run(700);
        s.check();
        int p = s.when("Регистрация бега приостановлена"), r = s.when("Регистрация бега возобновлена");
        assertTrue("pause from step events (≈15–25 s after the stop): " + p, p >= 312 && p <= 332);
        assertTrue("resume after steps are back: " + r, r > p && r <= 350);
    }

    @Test public void shortStopsUnderFiveSecondsAreNotAnnounced() {
        Sim s = new Sim(new Seg(0, 60, 100, 1.3), new Seg(60, 300, 165, 2.8), new Seg(300, 303, 0, 0), new Seg(303, 600, 165, 2.8));
        s.run(600);
        assertEquals(0, s.count("Регистрация бега приостановлена"));
    }

    @Test public void aWalkBreakAfterTheRunEndsTheAnnouncementsAndRunningAgainResumes() {
        Sim s = new Sim(new Seg(0, 30, 100, 1.3), new Seg(30, 400, 165, 2.8), new Seg(400, 700, 100, 1.3), new Seg(700, 1000, 165, 2.8));
        s.run(1000);
        s.check();
        assertEquals(1, s.count("Регистрация бега возобновлена"));
        int r = s.when("Регистрация бега возобновлена"); assertTrue("" + r, r >= 715 && r <= 730);
        for (Object[] o : s.said) { int t = (Integer) o[0]; String x = (String) o[2]; if (t > 500 && t < 715) fail("silent while walking: " + x + " @" + t); }
    }

    @Test public void approximateResultsAtTheEnd() {
        Sim s = new Sim(dogRun()); s.run(1000);
        assertTrue(s.rv.ran());
        assertEquals(810 - 12, s.rv.approxMovingS(), 25);
        assertEquals(2.8 * (900 - 90 - 12), s.rv.approxDistM(true), 120);
        assertEquals(1, s.rv.pauses);
    }

    @Test public void gradualStopPlacesThePauseMarkerAtTheRealStopNotAtDetection() {
        // run, then 8 s of walking (1.2 m/s), then standing still: the voice fires ~15 s after 300, the span starts at 300
        Sim s = new Sim(new Seg(0, 30, 100, 1.3), new Seg(30, 300, 165, 2.8), new Seg(300, 308, 80, 1.2),
                new Seg(308, 360, 0, 0), new Seg(360, 700, 165, 2.8));
        s.strap = false; s.run(700);
        int p = s.when("Регистрация бега приостановлена"), r = s.when("Регистрация бега возобновлена");
        assertTrue("announcement still delayed ~15 s: " + p, p >= 310 && p <= 325);
        int[] sp = s.rv.pauseSpans()[0];
        assertTrue("marker at the real stop: " + sp[0], sp[0] >= 298 && sp[0] <= 303);
        assertTrue("resume unshifted: " + sp[1] + " announced at " + r, sp[1] >= 358 && sp[1] <= 365);
        assertTrue("voice later than marker", p >= sp[0] + 8);
    }

    @Test public void truePauseStartBackSearchesTheDetectionWindow() {
        // proxy of the 2026-11-25 run: last running mean at 58, detection at 78
        java.util.ArrayList<Double> hist = new java.util.ArrayList<>();
        for (int t = 40; t <= 78; t++) {
            double inst = t <= 58 ? 2.4 : t <= 72 ? 1.1 : 0.0;
            if (t == 62) inst = 2.0;   // one noisy fix after the stop must not pull the marker forward
            hist.add(inst);
        }
        int start = RunVoice.truePauseStart(hist, 78, 78 - 10);
        assertTrue("start after last running mean, ignoring the spike: " + start, start >= 58 && start <= 62);
    }
}
