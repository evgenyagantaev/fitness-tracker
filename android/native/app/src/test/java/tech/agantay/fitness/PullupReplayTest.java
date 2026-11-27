package tech.agantay.fitness;

import org.junit.Test;
import java.nio.file.*;
import java.util.*;

/** PU_REPLAY=csv[:goMs] — replays a recorded set (t_ms,ax,ay,az; kept outside the repo) and prints rep times to /tmp/pu-replay.txt */
public class PullupReplayTest {
    @Test public void replay() throws Exception {
        String a = System.getenv("PU_REPLAY");
        if (a == null) return;
        String[] p = a.split(":");
        long go = p.length > 1 ? Long.parseLong(p[1]) : 0;
        boolean dbg = System.getenv("PU_REPLAY_DEBUG") != null;
        if (dbg) PullupCounter.debug = new StringBuilder();
        List<String> lines = Files.readAllLines(Paths.get(p[0]));
        if (System.getenv("PU_REPLAY_SWEEP") != null) {
            StringBuilder sw = new StringBuilder();
            double[] disp = { 0.09, 0.11, 0.13, 0.16, 0.20, 0.25 }, floor = { 0.08, 0.12, 0.16, 0.20 }, taus = { 0.9, 1.2, 1.6 };
            for (double d : disp) for (double fl : floor) for (double tau : taus) {
                PullupCounter.DISP_MIN = d; PullupCounter.V_FLOOR = fl; PullupCounter.VEL_TAU = tau;
                sw.append(String.format(Locale.ROOT, "disp=%.2f floor=%.2f tau=%.1f -> %d%n", d, fl, tau, run(lines, go)));
            }
            PullupCounter.DISP_MIN = 0.13; PullupCounter.V_FLOOR = 0.12; PullupCounter.VEL_TAU = 1.2;
            Files.write(Paths.get("/tmp/pu-replay-sweep.txt"), sw.toString().getBytes());
        }
        PullupCounter c = new PullupCounter();
        StringBuilder out = new StringBuilder();
        boolean went = false;
        for (String line : lines) {
            String[] f = line.split(",");
            long t = Long.parseLong(f[0]);
            if (!went && t >= go) { c.go(1000 + t); went = true; }
            boolean rep = c.onSample(1000 + t, Double.parseDouble(f[1]), Double.parseDouble(f[2]), Double.parseDouble(f[3]));
            if (rep) out.append("REP ").append(c.reps()).append(" at ").append(t).append(" ms\n");
            if (c.closeReason() != null && out.indexOf("CLOSE") < 0) out.append("CLOSE ").append(c.closeReason()).append(" at ").append(t).append(" ms\n");
        }
        out.append("total ").append(c.reps()).append("\n");
        Files.write(Paths.get("/tmp/pu-replay.txt"), out.toString().getBytes());
        if (dbg) { Files.write(Paths.get("/tmp/pu-debug.txt"), PullupCounter.debug.toString().getBytes()); PullupCounter.debug = null; }
    }

    static int run(List<String> lines, long go) {
        PullupCounter c = new PullupCounter(); boolean went = false;
        for (String line : lines) {
            String[] f = line.split(","); long t = Long.parseLong(f[0]);
            if (!went && t >= go) { c.go(1000 + t); went = true; }
            c.onSample(1000 + t, Double.parseDouble(f[1]), Double.parseDouble(f[2]), Double.parseDouble(f[3]));
        }
        return c.reps();
    }
}
