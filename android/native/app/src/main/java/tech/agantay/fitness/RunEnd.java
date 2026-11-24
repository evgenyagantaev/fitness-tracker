package tech.agantay.fitness;

import java.util.List;

/**
 * v1.7: «forgot to press Стоп». A compact, allocation-light twin of the run detector in analysis.js (same thresholds):
 * a 5-s bin is running when cadence (20-s window of the step counter) ≥ 135 steps/min and GPS speed (30-s window) ≥ 1.7 m/s,
 * each falling back to the other when missing. Pure functions → unit-tested on the JVM.
 *
 * verdict(): the run is considered over when nothing running has happened for a while:
 *   without a strap: notify after 10 min, close by itself after 15 min;
 *   with a strap that still delivers HR: notify after 4 min if the HR has fallen ≥ 15 bpm from the run level, close after 12 min.
 */
final class RunEnd {
    static final double RUN_CAD = 135, STRONG_CAD = 150, RUN_SPEED = 1.7, SPEED_ALONE = 2.0;
    static final int MIN_RUN_S = 40, BIN_S = 5, WIN_CAD_S = 20, WIN_SPD_S = 30, COOLDOWN_KEEP_S = 20;
    static final int NOTIFY_NOBELT_S = 600, CLOSE_NOBELT_S = 900, NOTIFY_BELT_S = 240, CLOSE_BELT_S = 720;
    static final double HR_DROP = 15;

    static final class Verdict {
        boolean ran;          // a real run (≥ MIN_RUN_S of running bins) has happened
        int lastRunSec = -1;  // end of the last running bin, seconds from «Старт»
        int idleSec;          // seconds since then
        boolean notify, close;
        boolean hrEvidence;   // the HR fell towards rest
    }

    /** cumulative steps at t; Double.NaN before the first event (counter lag) */
    static double stepsAt(List<int[]> ss, int nowSec, double t) {
        int n = ss.size();
        if (n == 0 || t < ss.get(0)[0] - 0.001) return Double.NaN;
        if (t >= ss.get(n - 1)[0]) return ss.get(n - 1)[1];
        int lo = 0, hi = n - 1;
        while (hi - lo > 1) { int m = (lo + hi) >>> 1; if (ss.get(m)[0] <= t) lo = m; else hi = m; }
        int[] a = ss.get(lo), b = ss.get(hi);
        return b[0] == a[0] ? b[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
    }

    static double hav(double la1, double lo1, double la2, double lo2) {
        double R = 6371008.8, r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
        double x = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
    }
    /** nearest good fix (acc ≤ 25) within maxD s of t, or null */
    static double[] fixNear(List<double[]> tr, double t, double maxD) {
        double[] best = null; double bd = maxD + 1e-9;
        for (int i = tr.size() - 1; i >= 0; i--) {
            double[] p = tr.get(i);
            if (p[0] < t - maxD) break;
            if (p.length > 3 && p[3] > 25) continue;
            double d = Math.abs(p[0] - t);
            if (d <= bd) { bd = d; best = p; }
        }
        return best;
    }
    static double speedAt(List<double[]> tr, double c) {
        if (tr.size() < 2) return Double.NaN;
        double a = c - WIN_SPD_S / 2.0, b = c + WIN_SPD_S / 2.0;
        double[] pa = fixNear(tr, a, 6), pb = fixNear(tr, b, 6);
        if (pa == null || pb == null || pb[0] - pa[0] < WIN_SPD_S / 2.0) return Double.NaN;
        return hav(pa[1], pa[2], pb[1], pb[2]) / (pb[0] - pa[0]);
    }
    /** 1 running, 0 not, -1 unknown */
    static int binRun(List<int[]> ss, List<double[]> tr, int nowSec, double c) {
        double a = Math.max(0, c - WIN_CAD_S / 2.0), b = Math.min(nowSec, c + WIN_CAD_S / 2.0), cad = Double.NaN;
        if (b - a >= WIN_CAD_S / 2.0) {
            double sa = stepsAt(ss, nowSec, a), sb = stepsAt(ss, nowSec, b);
            if (!Double.isNaN(sa) && !Double.isNaN(sb)) cad = (sb - sa) * 60.0 / (b - a);
        }
        double spd = speedAt(tr, c);
        boolean hc = !Double.isNaN(cad), hs = !Double.isNaN(spd);
        if (!hc && !hs) return -1;
        if (!hc) return spd >= SPEED_ALONE ? 1 : 0;
        if (!hs) return cad >= RUN_CAD ? 1 : 0;
        if (cad >= RUN_CAD) return spd >= RUN_SPEED || (cad >= STRONG_CAD && spd >= 0.6) ? 1 : 0;
        return cad >= 100 && spd >= 2.4 ? 1 : 0;
    }

    /**
     * @param hr HR samples [sec, bpm] (may be empty); hasStrap: a strap was chosen for this workout
     */
    static Verdict verdict(List<int[]> ss, List<double[]> tr, List<int[]> hr, boolean hasStrap, int nowSec) {
        Verdict v = new Verdict();
        int runBins = 0, last = -1;
        for (int c = 0; c <= nowSec; c += BIN_S) if (binRun(ss, tr, nowSec, c) == 1) { runBins++; last = c; }
        if (runBins * BIN_S < MIN_RUN_S) return v;
        v.ran = true;
        v.lastRunSec = Math.min(nowSec, last + WIN_CAD_S / 2);
        v.idleSec = nowSec - v.lastRunSec;
        // HR: level during the last 3 min of running vs the last 2 min now
        boolean hrNow = false;
        if (hasStrap && hr != null && !hr.isEmpty()) {
            double sNow = 0, sRun = 0; int nNow = 0, nRun = 0;
            for (int[] p : hr) {
                if (p[0] > nowSec - 120 && p[0] <= nowSec) { sNow += p[1]; nNow++; }
                if (p[0] > v.lastRunSec - 180 && p[0] <= v.lastRunSec) { sRun += p[1]; nRun++; }
            }
            hrNow = nNow >= 30;                          // the strap still delivers
            if (hrNow && nRun >= 30) v.hrEvidence = sRun / nRun - sNow / nNow >= HR_DROP;
        }
        if (hasStrap && hrNow) {
            v.notify = v.idleSec >= NOTIFY_BELT_S && v.hrEvidence;
            v.close = v.idleSec >= CLOSE_BELT_S && v.hrEvidence;
        } else {
            v.notify = v.idleSec >= NOTIFY_NOBELT_S;
            v.close = v.idleSec >= CLOSE_NOBELT_S;
        }
        return v;
    }
}
