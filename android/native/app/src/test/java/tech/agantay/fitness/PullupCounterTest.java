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
        /** soft hang on a door-frame bar: reach up, take the weight, no flight */
        void hangOnBar() {
            move(0.12, 0.55);     // reach for the bar
            move(-0.08, 0.45);    // arms take the weight, slight settle
            hold(0.35);
        }
        /** soft step down onto the floor, no free fall (door-frame bar: short drop, then stand still) */
        void stepDown() {
            move(-0.10, 0.70);    // lower until the feet take the weight
            hold(0.50);           // stand still so the zero-velocity update settles before any walk
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

    /** standing countdown, walk to the bar, soft hang, n reps, soft step down, stand, walk away */
    static Trace fullSet(int n, Random r, boolean slowing) {
        Trace tr = new Trace();
        tr.hold(3);            // countdown (pocketing the phone)
        tr.hold(3);            // walking to the bar (accelerations added as walking window)
        tr.hangOnBar();
        tr.hold(0.3 + 0.7 * r.nextDouble());
        tr.pullups(n, r, 0.38, 0.55, slowing);
        tr.hold(2.0);          // hang still at the bottom so the zero-velocity update settles
        tr.stepDown();
        tr.hold(20);           // stand / walk away (idle close is 6 s)
        return tr;
    }

    @Test public void countsOneToFifteenPocketAndNeck() {
        for (String mount : new String[] { "pocket", "neck" }) {
            for (int n = 1; n <= 15; n++) {
                for (int seed = 0; seed < 4; seed++) {
                    Random r = new Random(n * 100 + seed + (mount.equals("neck") ? 7777 : 0));
                    Trace tr = fullSet(n, r, seed % 2 == 0);
                    double setEnd = tr.end() - 20;
                    PullupCounter c = run(tr, mount, r, 3.0, 3.0, 6.0, new double[] { setEnd + 10.0, setEnd + 20 }, null);
                    assertEquals(mount + " n=" + n + " seed=" + seed, n, c.reps());
                    assertEquals(mount + " n=" + n + " seed=" + seed + " close", "idle", c.closeReason());
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

    @Test public void softStepDownClosesByIdle() {
        Random r = new Random(9);
        Trace tr = new Trace(); tr.hold(2); tr.hangOnBar(); tr.pullups(5, r, 0.4, 0.5, false);
        tr.hold(2.0);
        tr.stepDown();
        tr.hold(12);
        PullupCounter c = run(tr, "pocket", r, 1.0, -1, -1, null, null);
        assertEquals(5, c.reps());
        assertEquals("idle", c.closeReason());
        assertTrue("idle should fire about 6 s after the last rep", c.closeAt() - c.lastRepT() >= 6000 && c.closeAt() - c.lastRepT() < 6500);
    }

    @Test public void walkingAfterStepDownAddsNothing() {
        for (String mount : new String[] { "pocket", "neck" }) {
            Random r = new Random(21);
            Trace tr = new Trace(); tr.hold(2); tr.hangOnBar(); tr.hold(0.6); tr.pullups(7, r, 0.4, 0.5, true);
            tr.hold(2.0);
            double off = tr.end();
            tr.stepDown(); tr.hold(20);
            PullupCounter c = run(tr, mount, r, 1.0, off + 1.0, off + 20, null, null);
            assertEquals(mount, 7, c.reps());
            assertEquals(mount, "idle", c.closeReason());
        }
    }

    @Test public void lastLoweringIntoASoftStepDownStillCountsThatRep() {
        Random r = new Random(11);
        Trace tr = new Trace(); tr.hold(2); tr.hangOnBar(); tr.hold(0.5);
        tr.pullups(3, r, 0.45, 0.5, false);
        tr.move(0.45, 0.9); tr.hold(0.2); tr.move(-0.25, 0.5);   // 4th rep: lowered half-way...
        tr.stepDown();                                           // ...and softly stepped onto the floor
        tr.hold(12);
        PullupCounter c = run(tr, "neck", r, 1.0, -1, -1, null, null);
        assertEquals(4, c.reps());
        assertEquals("idle", c.closeReason());
    }

    @Test public void halfRepsAreNotCounted() {
        Random r = new Random(13);
        Trace tr = new Trace(); tr.hold(2); tr.hangOnBar(); tr.hold(1);
        for (int i = 0; i < 4; i++) { tr.move(0.08, 0.5); tr.move(-0.08, 0.5); tr.hold(0.5); }   // shoulder shrugs
        tr.hold(20);
        PullupCounter c = run(tr, "pocket", r, 1.0, -1, -1, null, null);
        assertEquals(0, c.reps());
    }

    @Test public void slowRepsCount() {
        Random r = new Random(17);
        Trace tr = new Trace(); tr.hold(2); tr.hangOnBar(); tr.hold(1);
        for (int i = 0; i < 6; i++) { tr.move(0.42, 2.2); tr.hold(0.3); tr.move(-0.42, 2.5); tr.hold(0.4); }  // count-to-count ~5.4 s, under the 6 s idle close
        tr.stepDown(); tr.hold(12);
        // pocket: a 2.2 s rise is still counted. On the neck with a strongly swinging case such slow reps can be missed
        // (the swing is as large as the rep's own acceleration) — tune from real sets.
        PullupCounter c = run(tr, "pocket", r, 1.0, -1, -1, null, null);
        assertEquals(6, c.reps());
    }

    /** door-frame set: soft hang, 4 reps, soft step down, then walk — no extra rep, closes by idle at 6 s */
    @Test public void softHangStepDownAndWalkIsFour() {
        for (String mount : new String[] { "pocket", "neck" }) {
            Random r = new Random(42 + (mount.equals("neck") ? 9 : 0));
            Trace tr = new Trace();
            tr.hold(3); tr.hangOnBar(); tr.hold(0.8);
            tr.pullups(4, r, 0.40, 0.52, false);
            tr.hold(2.0);
            double off = tr.end();
            tr.stepDown(); tr.hold(16);
            PullupCounter c = run(tr, mount, r, 1.0, off + 1.2, off + 16, null, null);
            assertEquals(mount, 4, c.reps());
            assertEquals(mount, "idle", c.closeReason());
            assertTrue(mount, c.closeAt() - c.lastRepT() >= 6000 && c.closeAt() - c.lastRepT() < 6500);
        }
    }


    @Test public void undo() {
        PullupCounter c = new PullupCounter();
        assertFalse(c.undo());
    }
}
