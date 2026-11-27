package tech.agantay.fitness;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * v1.17: pull-up reps from the phone accelerometer (pocket or on the neck). Pure, unit-tested on synthetic signals.
 *
 * Orientation-free: the body moves almost only vertically on the bar, so |a| − g ≈ vertical acceleration whatever way the phone
 * lies (pocket, swinging case). Pipeline per sample: magnitude → minus slow baseline (τ 3 s, also absorbs sensor scale error) →
 * light smoothing (τ 0.08 s) → leaky integral = vertical velocity v (τ 2.5 s, kills drift).
 * One rep = an UP phase (v above vUp, ≥ DISP_MIN of rise) followed by a DOWN phase (v below −vDn, ≥ DISP_MIN of lowering),
 * counted when the lowering stops at the bottom. Jumping onto the bar merges with the first rep's rise (no extra count); the small
 * drop when the arms straighten is far below DISP_MIN. Thresholds adapt: vUp/vDn = max(floor, 0.35 × median peak of earlier reps).
 * Landing (≥ FREEFALL_MS of |a| < 0.45 g, then a ≥ 1.6 g impact) closes the set LAND_CLOSE_MS later; no rep for IDLE_CLOSE_MS too.
 */
final class PullupCounter {
    static final double G = 9.80665;
    static final double BASE_TAU = 20.0, SMOOTH_TAU = 0.08;
    // tunables (not final so the synthetic-signal tests can sweep them)
    static double VEL_TAU = 1.2, DOWN_EXIT = 0.25;
    static double V_FLOOR = 0.12, ADAPT = 0.30, V_CAP = 0.45;   // m/s
    static double DISP_MIN = 0.13;   // m (real rise 0.4–0.6 m, the filters keep ~70–90 % of it; arms settling after the jump ≈ 0.06)
    static final long MIN_REP_MS = 1000, FREEFALL_MS = 120, LAND_WINDOW_MS = 1200;
    static final double FREEFALL_A = 0.45 * G, LAND_A = 1.6 * G;
    static final long LAND_CLOSE_MS = 2500, IDLE_CLOSE_MS = 15_000, EMPTY_CLOSE_MS = 180_000, LAND_MUTE_MS = 1500;

    enum Phase { WAIT, UP, DOWN }
    static StringBuilder debug = null;   // tests only

    private boolean init = false;
    private long lastT = 0;
    private double base = G, sm = 0, v = 0, lp2 = G, calmRef = G;
    private long calmSince = 0;
    static final double CALM_TAU = 0.12, V_CLAMP = 1.5;
    static double CALM_BAND = 0.1, CALM_DEV = 0.1;
    static final long CALM_MS = 500;
    static final int WIN = 256;   // ≥ 2 × CALM_MS of samples at up to 200 Hz
    private final long[] winT = new long[WIN];
    private final double[] winV = new double[WIN];
    private int winI = 0;
    private Phase phase = Phase.WAIT;
    private double upPeak, upDisp, dnPeak, dnDisp, riseDisp, fallDisp;
    private boolean counting = false;
    private long goT = 0;
    private int reps = 0;
    private final List<Long> repT = new ArrayList<>();
    private final List<Double> peaks = new ArrayList<>();
    private long ffStart = -1, ffEnd = -1, landT = -1;
    private String closeReason = null;
    private long closeAt = -1;

    /** reps start counting from here (end of the countdown); the filters already run before */
    void go(long t) { counting = true; goT = t; phase = Phase.WAIT; }
    boolean counting() { return counting; }
    int reps() { return reps; }
    List<Long> repTimes() { return repT; }
    long lastRepT() { return repT.isEmpty() ? -1 : repT.get(repT.size() - 1); }
    double velocity() { return v; }
    Phase phase() { return phase; }
    long landT() { return landT; }

    double vThr() {
        if (peaks.isEmpty()) return V_FLOOR;
        double[] a = new double[peaks.size()];
        for (int i = 0; i < a.length; i++) a[i] = peaks.get(i);
        Arrays.sort(a);
        double med = a[a.length / 2];
        return Math.max(V_FLOOR, Math.min(V_CAP, ADAPT * med));
    }

    boolean undo() {
        if (reps < 1) return false;
        reps--; repT.remove(repT.size() - 1);
        if (!peaks.isEmpty()) peaks.remove(peaks.size() - 1);
        return true;
    }

    /** @param t ms (monotonic), a* in m/s². @return true if this sample completed a rep */
    boolean onSample(long t, double ax, double ay, double az) {
        double m = Math.sqrt(ax * ax + ay * ay + az * az);
        if (!init) { init = true; lastT = t; base = lp2 = calmRef = m > 3 && m < 20 ? m : G; calmSince = t; return false; }
        double dt = (t - lastT) / 1000.0;
        long prevT = lastT;
        lastT = t;
        if (dt <= 0) return false;
        if (dt > 0.1) dt = 0.1;
        // landing detector on the raw magnitude
        boolean fellNow = false;
        boolean ffOver = false;
        if (m < FREEFALL_A) { if (ffStart < 0) ffStart = t; ffEnd = t; fellNow = ffEnd - ffStart >= FREEFALL_MS; }
        else {
            ffOver = ffStart >= 0 && ffEnd == prevT && ffEnd - ffStart >= FREEFALL_MS;
            if (ffStart >= 0 && ffEnd - ffStart >= FREEFALL_MS && m > LAND_A && t - ffEnd <= LAND_WINDOW_MS) { landT = t; ffStart = -1; }
            else if (ffStart >= 0 && t - ffEnd > LAND_WINDOW_MS) ffStart = -1;
        }
        // baseline only follows calm signal, so a long hang or a rep does not drag it
        double clipped = Math.max(base - 3, Math.min(base + 3, m));
        base += (clipped - base) * dt / BASE_TAU;
        // stillness (hanging, top/bottom pause, standing): the true velocity is 0 → zero-velocity update + baseline snap.
        // A real rep never stays within ±0.25 m/s² of |a| for 0.6 s, so this cannot cut one in half.
        lp2 += (m - lp2) * Math.min(1.0, dt / CALM_TAU);
        if (Math.abs(m - lp2) > 2.0) calmSince = t;
        winT[winI] = t; winV[winI] = lp2; winI = (winI + 1) % WIN;
        double lo = lp2, hi = lp2; long oldest = t;
        for (int k = 0; k < WIN; k++) {
            if (winT[k] == 0 || t - winT[k] > CALM_MS) continue;   // range over the last CALM_MS; calmSince holds the longer part
            if (winV[k] < lo) lo = winV[k]; if (winV[k] > hi) hi = winV[k];
            if (winT[k] < oldest) oldest = winT[k];
        }
        calmRef = hi - lo;
        // a slow rep's steady middle looks still too, so inside UP/DOWN it takes twice as long
        long need = 2 * CALM_MS;
        boolean still = hi - lo < 2 * CALM_BAND && Math.abs(lp2 - base) < CALM_DEV && t - oldest >= CALM_MS - 60;
        if (!still) calmSince = t;   // calmSince = when the last CALM_MS window first looked still
        boolean calm = still && t - calmSince + CALM_MS >= need;
        if (calm) base += (lp2 - base) * Math.min(1.0, dt / 0.3);
        double av = m - base;
        sm += (av - sm) * Math.min(1.0, dt / SMOOTH_TAU);
        v += sm * dt;
        v -= v * dt / VEL_TAU;
        if (calm) v -= v * Math.min(1.0, dt / 0.1);
        if (v > V_CLAMP) v = V_CLAMP; else if (v < -V_CLAMP) v = -V_CLAMP;
        // end of a flight: jumping up you grab the bar at the apex (v = 0 there); the jump's push-off is not a rise
        if (ffOver && phase != Phase.DOWN) { v = 0; sm = 0; phase = Phase.WAIT; riseDisp = fallDisp = 0; }

        // distance moved since v last changed sign, so a phase starts with the part before v crossed the threshold
        if (v > 0) { riseDisp += v * dt; fallDisp = 0; } else { fallDisp -= v * dt; riseDisp = 0; }
        double thr = vThr();
        boolean rep = false;
        Phase was = phase;
        switch (phase) {
            case WAIT:
                if (v > thr) { phase = Phase.UP; upPeak = v; upDisp = riseDisp; }
                break;
            case UP:
                if (v > 0) upDisp += v * dt;
                if (v > upPeak) upPeak = v;
                if (v < -thr) {
                    if (upDisp >= DISP_MIN) { phase = Phase.DOWN; dnPeak = v; dnDisp = fallDisp; }
                    else phase = Phase.WAIT;
                }
                break;
            case DOWN:
                if (v < 0) dnDisp -= v * dt;
                if (v < dnPeak) dnPeak = v;
                if (fellNow) {   // let go of the bar while lowering: the rep is done, the fall is not a new one
                    if (dnDisp >= DISP_MIN) rep = countRep(t);
                    phase = Phase.WAIT;
                    break;
                }
                if (dnDisp >= DISP_MIN && v > DOWN_EXIT * dnPeak) {   // lowered far enough and the lowering has (nearly) stopped
                    rep = countRep(t);
                    phase = v > thr ? Phase.UP : Phase.WAIT;
                    if (phase == Phase.UP) { upPeak = v; upDisp = riseDisp; }
                } else if (v > thr) {                             // went up again before lowering far: not a rep, a new rise
                    phase = Phase.UP; upPeak = v; upDisp = riseDisp;
                }
                break;
        }
        if (debug != null && (t % 50 == 0 || was != phase)) debug.append(String.format(java.util.Locale.ROOT, "%d m=%.2f av=%.2f v=%.3f %s up=%.2f dn=%.2f lp2=%.2f ref=%.2f cs=%d base=%.2f%s%n", t, m, sm, v, phase, upDisp, dnDisp, lp2, calmRef, calmSince, base, rep ? " REP" : ""));
        // closing
        if (counting && closeReason == null) {
            if (reps > 0 && landT >= 0 && landT > lastRepT() - 300 && t - landT >= LAND_CLOSE_MS) close("landed", t);
            else if (reps > 0 && t - lastRepT() >= IDLE_CLOSE_MS) close("idle", t);
            else if (reps == 0 && t - goT >= EMPTY_CLOSE_MS) close("empty", t);
        }
        return rep;
    }

    private boolean countRep(long t) {
        if (!counting) return false;
        if (landT >= 0 && t - landT < LAND_MUTE_MS) return false;    // the landing bounce is not a rep
        if (!repT.isEmpty() && t - lastRepT() < MIN_REP_MS) return false;
        reps++; repT.add(t);
        peaks.add(Math.min(upPeak, -dnPeak));
        return true;
    }

    private void close(String why, long t) { closeReason = why; closeAt = t; }
    /** non-null once the set should be closed: "landed", "idle" or "empty" */
    String closeReason() { return closeReason; }
    long closeAt() { return closeAt; }
}
