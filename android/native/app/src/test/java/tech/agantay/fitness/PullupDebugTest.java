package tech.agantay.fitness;

import org.junit.Test;
import java.util.Random;

/** PU_DEBUG=slow|letgo|idle|full:n:seed:mount → /tmp/pu-debug.txt (skipped otherwise) */
public class PullupDebugTest {
    @Test public void dump() throws Exception {
        String w = System.getenv("PU_DEBUG");
        if (w == null) return;
        PullupCounter.debug = new StringBuilder();
        PullupCounterTest.Trace tr = new PullupCounterTest.Trace();
        Random r;
        if (w.equals("slow")) {
            r = new Random(17); tr.hold(2); tr.hangOnBar(); tr.hold(1);
            for (int i = 0; i < 6; i++) { tr.move(0.42, 2.2); tr.hold(0.3); tr.move(-0.42, 2.5); tr.hold(0.4); }
            tr.stepDown(); tr.hold(12);
            PullupCounterTest.run(tr, "neck", r, 1.0, -1, -1, null, null);
        } else if (w.equals("letgo")) {
            r = new Random(11); tr.hold(2); tr.hangOnBar(); tr.hold(0.5);
            tr.pullups(3, r, 0.45, 0.5, false);
            tr.move(0.45, 0.9); tr.hold(0.2); tr.move(-0.25, 0.5); tr.stepDown(); tr.hold(12);
            PullupCounterTest.run(tr, "neck", r, 1.0, -1, -1, null, null);
        } else if (w.equals("idle")) {
            r = new Random(9); tr.hold(2); tr.hangOnBar(); tr.pullups(5, r, 0.4, 0.5, false); tr.stepDown(); tr.hold(12);
            PullupCounterTest.run(tr, "pocket", r, 1.0, -1, -1, null, null);
        } else {
            String[] p = w.split(":"); int n = Integer.parseInt(p[1]), seed = Integer.parseInt(p[2]); String mount = p[3];
            r = new Random(n * 100 + seed + (mount.equals("neck") ? 7777 : 0));
            tr = PullupCounterTest.fullSet(n, r, seed % 2 == 0);
            double setEnd = tr.end() - 20;
            PullupCounterTest.run(tr, mount, r, 3.0, 3.0, 6.0, new double[] { setEnd + 10.0, setEnd + 20 }, null);
        }
        java.nio.file.Files.write(java.nio.file.Paths.get("/tmp/pu-debug.txt"), PullupCounter.debug.toString().getBytes());
        PullupCounter.debug = null;
    }
}
