package tech.agantay.fitness;

import org.junit.Test;
import java.util.Random;

/** PU_SWEEP=1: grid over the tunables, prints the error score of each (skipped otherwise) */
public class PullupSweepTest {
    static StringBuilder fails = null;
    static int[] score(int seeds) {
        int err = 0, worst = 0, fp = 0;
        for (String mount : new String[] { "pocket", "neck" })
            for (int n = 1; n <= 15; n++)
                for (int seed = 0; seed < seeds; seed++) {
                    Random r = new Random(n * 100 + seed + (mount.equals("neck") ? 7777 : 0) + 31 * seeds);
                    PullupCounterTest.Trace tr = PullupCounterTest.fullSet(n, r, seed % 2 == 0);
                    double setEnd = tr.end() - 20;
                    PullupCounter c = PullupCounterTest.run(tr, mount, r, 3.0, 3.0, 6.0, new double[] { setEnd + 10.0, setEnd + 20 }, null);
                    int e = Math.abs(c.reps() - n); err += e; worst = Math.max(worst, e);
                    if (e > 0 && fails != null) fails.append(mount + " n=" + n + " seed=" + seed + " got " + c.reps() + "; ");
                }
        for (String mount : new String[] { "pocket", "neck" })
            for (int seed = 0; seed < 3; seed++) {
                Random r = new Random(500 + seed);
                PullupCounterTest.Trace tr = new PullupCounterTest.Trace(); tr.hold(60);
                fp += PullupCounterTest.run(tr, mount, r, 1.0, 2.0, 58.0, null, null).reps();
                // slow reps
                r = new Random(900 + seed); tr = new PullupCounterTest.Trace(); tr.hold(2); tr.hangOnBar(); tr.hold(1);
                for (int i = 0; i < 6; i++) { tr.move(0.42, 2.0 + 0.3 * r.nextDouble()); tr.hold(0.6); tr.move(-0.42, 2.3 + 0.3 * r.nextDouble()); tr.hold(0.8); }
                tr.stepDown(); tr.hold(12);
                int e = Math.abs(PullupCounterTest.run(tr, mount, r, 1.0, -1, -1, null, null).reps() - 6); err += e; worst = Math.max(worst, e);
                if (e > 0 && fails != null) fails.append(mount + " slow seed=" + seed + "; ");
                // shrugs
                r = new Random(700 + seed); tr = new PullupCounterTest.Trace(); tr.hold(2); tr.hangOnBar(); tr.hold(1);
                for (int i = 0; i < 4; i++) { tr.move(0.08, 0.5); tr.move(-0.08, 0.5); tr.hold(0.5); }
                tr.hold(20);
                fp += PullupCounterTest.run(tr, mount, r, 1.0, -1, -1, null, null).reps();
            }
        return new int[] { err, worst, fp };
    }

    @Test public void sweep() {
        if (System.getenv("PU_SWEEP") == null) return;
        double[] taus = { 0.9, 1.0, 1.2 }, floors = { 0.12, 0.14 }, adapts = { 0.3 }, disps = { 0.09, 0.11, 0.13 }, exits = { 0.25 };
        StringBuilder sb = new StringBuilder();
        for (double tau : taus) for (double fl : floors) for (double ad : adapts) for (double dm : disps) for (double ex : exits) {
            PullupCounter.VEL_TAU = tau; PullupCounter.V_FLOOR = fl; PullupCounter.ADAPT = ad; PullupCounter.DISP_MIN = dm; PullupCounter.DOWN_EXIT = ex;
            fails = new StringBuilder();
            int[] s = score(4);
            sb.append(String.format(java.util.Locale.ROOT, "%d %d %d [%s] tau=%.1f floor=%.2f adapt=%.2f disp=%.2f exit=%.2f%n", s[0] + 3 * s[2], s[1], s[2], fails, tau, fl, ad, dm, ex));
        }
        try { java.nio.file.Files.write(java.nio.file.Paths.get("/tmp/pu-sweep.txt"), sb.toString().getBytes()); } catch (Exception ignored) {}
    }
}
