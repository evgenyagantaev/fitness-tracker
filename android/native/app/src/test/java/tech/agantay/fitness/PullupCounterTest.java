package tech.agantay.fitness;

import static org.junit.Assert.*;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/** synthetic pull-up sets: world vertical motion → specific force → rotated into a swinging / tilted phone, 100 Hz, noise */
public class PullupCounterTest {
    static final double G = 9.80665;

    /** builds a world-frame trace: vertical position z(t) plus horizontal accelerations from swinging, walking, etc. */
    static final class Trace {
        final List<double[]> pts = new ArrayList<>();   // t_s, z
        final List<double[]> extra = new ArrayList<>(); // t_s, ax_h, ay_h, az_extra (already accelerations)
        double t = 0, z = 0;
        void hold(double s) { segment(s, 0, false); }
        /** smooth move by dz metres over s seconds (raised cosine velocity) */
        void move(double dz, double s) { segment(s, dz, true); }
        private void segment(double s, double dz, boolean cos) {
            int n = (int) Math.round(s * 1000);
            double z0 = z;
            for (int i = 1; i <= n; i++) {
                double f = i / (double) n;
                double zz = cos ? z0 + dz * (1 - Math.cos(Math.PI * f)) / 2 : z0;
                pts.add(new double[] { t + i / 1000.0, zz });
            }
            t += n / 1000.0; z = z0 + dz;
        }
        /** free fall by h metres then a landing that stops in stopS seconds */
        void dropAndLand(double h, double stopS) {
            double vImp = Math.sqrt(2 * G * h), tf = vImp / G;
            int n = (int) Math.round(tf * 1000);
            double z0 = z;
            for (int i = 1; i <= n; i++) { double tt = i / 1000.0; pts.add(new double[] { t + tt, z0 - G * tt * tt / 2 }); }
            t += n / 1000.0; z = z0 - h;
            // constant deceleration
            int m = (int) Math.round(stopS * 1000); double a = vImp / stopS; double zs = z;
            for (int i = 1; i <= m; i++) { double tt = i / 1000.0; pts.add(new double[] { t + tt, zs - vImp * tt + a * tt * tt / 2 }); }
            t += m / 1000.0; z = zs - vImp * stopS + a * stopS * stopS / 2;
        }
        /** jump to the bar: push-off (2g up for 0.18 s from a squat), ballistic flight, grab at the apex */
        void jumpToBar() {
            move(-0.15, 0.4);                        // squat
            double a = 12.0, tp = 0.18, z0 = z;      // push-off: +12 m/s² above g
            int n = (int) Math.round(tp * 1000);
            for (int i = 1; i <= n; i++) { double tt = i / 1000.0; pts.add(new double[] { t + tt, z0 + a * tt * tt / 2 }); }
            t += tp; double v0 = a * tp; z = z0 + a * tp * tp / 2;
            double tf = v0 / G; int m = (int) Math.round(tf * 1000); double z1 = z;
            for (int i = 1; i <= m; i++) { double tt = i / 1000.0; pts.add(new double[] { t + tt, z1 + v0 * tt - G * tt * tt / 2 }); }
            t += m / 1000.0; z = z1 + v0 * tf - G * tf * tf / 2;
            move(-0.06, 0.3);                        // arms take the weight
        }
        void pullups(int n, Random r, double ampLo, double ampHi, boolean slowing) {
            for (int i = 0; i < n; i++) {
                double fat = slowing ? 1 + 0.08 * i : 1;
                double amp = ampLo + r.nextDouble() * (ampHi - ampLo);
                move(amp, (0.8 + 0.3 * r.nextDouble()) * fat);
                hold(0.15 + 0.3 * r.nextDouble());
                move(-amp, (0.9 + 0.4 * r.nextDouble()) * fat);
                hold(0.2 + 0.5 * r.nextDouble());
            }
        }
        double end() { return t; }
    }

    /** sample the trace into a counter; mount: "pocket" or "neck"; extras by time windows */
    static PullupCounter run(Trace tr, String mount, Random r, double goAt, double walkFrom, double walkTo, double[] walkWin2, List<Long> repsAt) {
        int N = tr.pts.size();
        double[] z = new double[N + 2];
        for (int i = 0; i < N; i++) z[i + 1] = tr.pts.get(i)[1];
        z[0] = z[1]; z[N + 1] = z[N];
        PullupCounter c = new PullupCounter();
        boolean went = false;
        double tilt = mount.equals("pocket") ? 1.2 : 0.15;   // rad from vertical
        double bias = 0.12 * (r.nextDouble() - 0.5) * 2;      // sensor scale/offset error, m/s²
        for (int ms = 0; ms + 10 < N; ms += 10) {
            int i = ms + 1 + (r.nextInt(3) - 1);  // jitter
            if (i < 2) i = 2; if (i > N - 1) i = N - 1;
            double t = i / 1000.0;
            double av = (z[i + 1] - 2 * z[i] + z[i - 1]) * 1e6;
            double fx = 0, fy = 0, fz = G + av;
            // swinging
            if (mount.equals("neck")) { fx += 1.8 * Math.sin(2 * Math.PI * 0.9 * t); fz += 0.4 * Math.sin(2 * Math.PI * 1.8 * t); }
            else { fx += 0.4 * Math.sin(2 * Math.PI * 0.7 * t); }
            boolean walking = (t >= walkFrom && t < walkTo) || (walkWin2 != null && t >= walkWin2[0] && t < walkWin2[1]);
            if (walking) {
                double sp = 2 * Math.PI * 1.8 * t;
                // vertical: zero-mean (heel-strike spikes paid back by the swing phase); horizontal adds the |a| bias
                fz += (mount.equals("pocket") ? 4.0 : 2.5) * Math.sin(sp) + (Math.sin(sp) > 0.97 ? 8 : 0) - 8 * 0.078;
                fx += 2.0 * Math.sin(sp / 2); fy += 1.0 * Math.cos(sp);
            }
            // orientation: tilt + wobble
            double th = tilt + (mount.equals("neck") ? 0.25 : 0.08) * Math.sin(2 * Math.PI * 0.9 * t + 0.3);
            double ps = 0.4 + 0.1 * Math.sin(2 * Math.PI * 0.5 * t);
            // rotate world→phone: about y by th then about z by ps
            double x1 = fx * Math.cos(th) - fz * Math.sin(th), z1 = fx * Math.sin(th) + fz * Math.cos(th), y1 = fy;
            double x2 = x1 * Math.cos(ps) + y1 * Math.sin(ps), y2 = -x1 * Math.sin(ps) + y1 * Math.cos(ps);
            double sx = x2 + r.nextGaussian() * 0.06, sy = y2 + r.nextGaussian() * 0.06, sz = z1 * (1 + bias / G) + r.nextGaussian() * 0.06;
            sx = Math.round(sx * 100) / 100.0; sy = Math.round(sy * 100) / 100.0; sz = Math.round(sz * 100) / 100.0;
            long tm = 50_000 + ms;
            if (!went && t >= goAt) { c.go(tm); went = true; }
            if (c.onSample(tm, sx, sy, sz) && repsAt != null) repsAt.add(tm);
            if (c.closeReason() != null) break;
        }
        return c;
    }

    /** standing countdown, walk to the bar, jump on, n reps, drop, stand, walk away */
    static Trace fullSet(int n, Random r, boolean slowing) {
        Trace tr = new Trace();
        tr.hold(3);            // countdown (pocketing the phone)
        tr.hold(3);            // walking to the bar (accelerations added as walking window)
        tr.jumpToBar();
        tr.hold(0.3 + 0.7 * r.nextDouble());
        tr.pullups(n, r, 0.38, 0.55, slowing);
        tr.dropAndLand(0.36, 0.09);
        tr.move(-0.1, 0.3); tr.move(0.1, 0.4);   // knees give and recover
        tr.hold(25);           // stand / walk away
        return tr;
    }

    @Test public void countsOneToFifteenPocketAndNeck() {
        for (String mount : new String[] { "pocket", "neck" }) {
            for (int n = 1; n <= 15; n++) {
                for (int seed = 0; seed < 4; seed++) {
                    Random r = new Random(n * 100 + seed + (mount.equals("neck") ? 7777 : 0));
                    Trace tr = fullSet(n, r, seed % 2 == 0);
                    double setEnd = tr.end() - 25;
                    PullupCounter c = run(tr, mount, r, 3.0, 3.0, 6.0, new double[] { setEnd + 3.5, setEnd + 25 }, null);
                    assertEquals(mount + " n=" + n + " seed=" + seed, n, c.reps());
                    assertEquals(mount + " n=" + n + " seed=" + seed + " close", "landed", c.closeReason());
                }
            }
        }
    }

    @Test public void walkingAloneIsNotReps() {
        for (String mount : new String[] { "pocket", "neck" }) {
            Random r = new Random(5);
            Trace tr = new Trace(); tr.hold(60);
            PullupCounter c = run(tr, mount, r, 1.0, 2.0, 58.0, null, null);
            assertEquals(mount, 0, c.reps());
        }
    }

    @Test public void dropWithoutLandingClosesByIdle() {
        Random r = new Random(9);
        Trace tr = new Trace(); tr.hold(2); tr.jumpToBar(); tr.pullups(5, r, 0.4, 0.5, false);
        tr.move(-0.3, 0.6);   // stepped down from a box gently
        tr.hold(20);
        PullupCounter c = run(tr, "pocket", r, 1.0, -1, -1, null, null);
        assertEquals(5, c.reps());
        assertEquals("idle", c.closeReason());
    }

    @Test public void walkingAwayWithoutALandingAddsNothing() {
        for (String mount : new String[] { "pocket", "neck" }) {
            Random r = new Random(21);
            Trace tr = new Trace(); tr.hold(2); tr.jumpToBar(); tr.hold(0.6); tr.pullups(7, r, 0.4, 0.5, true);
            double off = tr.end();
            tr.move(-0.3, 0.6); tr.hold(30);
            PullupCounter c = run(tr, mount, r, 1.0, off + 1.0, off + 30, null, null);
            assertEquals(mount, 7, c.reps());
            assertEquals(mount, "idle", c.closeReason());
        }
    }

    @Test public void letGoWhileLoweringStillCountsThatRep() {
        Random r = new Random(11);
        Trace tr = new Trace(); tr.hold(2); tr.jumpToBar(); tr.hold(0.5);
        tr.pullups(3, r, 0.45, 0.5, false);
        tr.move(0.45, 0.9); tr.hold(0.2); tr.move(-0.25, 0.5);   // 4th rep: lowered half-way...
        tr.dropAndLand(0.3, 0.08);                               // ...and let go
        tr.hold(8);
        PullupCounter c = run(tr, "neck", r, 1.0, -1, -1, null, null);
        assertEquals(4, c.reps());
    }

    @Test public void halfRepsAreNotCounted() {
        Random r = new Random(13);
        Trace tr = new Trace(); tr.hold(2); tr.jumpToBar(); tr.hold(1);
        for (int i = 0; i < 4; i++) { tr.move(0.08, 0.5); tr.move(-0.08, 0.5); tr.hold(0.5); }   // shoulder shrugs
        tr.hold(20);
        PullupCounter c = run(tr, "pocket", r, 1.0, -1, -1, null, null);
        assertEquals(0, c.reps());
    }

    @Test public void slowRepsCount() {
        Random r = new Random(17);
        Trace tr = new Trace(); tr.hold(2); tr.jumpToBar(); tr.hold(1);
        for (int i = 0; i < 6; i++) { tr.move(0.42, 2.2); tr.hold(0.8); tr.move(-0.42, 2.5); tr.hold(1.0); }
        tr.dropAndLand(0.35, 0.09); tr.hold(6);
        // pocket: a 2.2 s rise is still counted. On the neck with a strongly swinging case such slow reps can be missed
        // (the swing is as large as the rep's own acceleration) — tune from real sets.
        PullupCounter c = run(tr, "pocket", r, 1.0, -1, -1, null, null);
        assertEquals(6, c.reps());
    }

    /** v1.17.1 regression (first real set): short |a| dips of a swinging pocket must not add up to a "flight" */
    @Test public void brokenLowDipsAreNotFreeFall() {
        PullupCounter c = new PullupCounter();
        long t = 1000;
        for (int i = 0; i < 300; i++, t += 10) c.onSample(t, 0, 0, 9.8);
        c.go(t);
        for (int i = 0; i < 100; i++, t += 10) {          // 1 s: 60 ms dips to 3 m/s², 40 ms normal, repeated
            double a = (i % 10) < 6 ? 3.0 : 9.8;
            c.onSample(t, 0, 0, a);
        }
        for (int i = 0; i < 20; i++, t += 10) c.onSample(t, 0, 0, 25);   // an impact right after: no landing without a real fall
        assertEquals(-1, c.landT());
    }

    @Test public void undo() {
        PullupCounter c = new PullupCounter();
        assertFalse(c.undo());
    }
}
