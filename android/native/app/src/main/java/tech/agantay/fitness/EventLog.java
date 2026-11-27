package tech.agantay.fitness;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * v1.16: a small on-device log of the live run decisions (pause/resume decision with the strap's last step, voice phrase queued /
 * spoken, service tick gaps). It is stored with the workout so the next run shows where a perceived delay comes from.
 * No coordinates, no names, no health data: only seconds since «Старт» and short tags.
 */
final class EventLog {
    private static final int CAP = 400;
    private static final ArrayList<String> lines = new ArrayList<>();
    private static long t0 = 0;
    private static int dropped = 0;

    private EventLog() {}

    /** a new workout starts: forget the old log; times are written as seconds since startMs */
    static synchronized void reset(long startMs) { lines.clear(); t0 = startMs; dropped = 0; }

    /** a service that restarts mid-run keeps (or starts) the clock of the run */
    static synchronized void ensure(long startMs) { if (t0 == 0) t0 = startMs; }

    static synchronized void add(String s) {
        long now = System.currentTimeMillis();
        double sec = t0 > 0 ? (now - t0) / 1000.0 : 0;
        if (lines.size() >= CAP) { lines.remove(0); dropped++; }
        lines.add(String.format(Locale.ROOT, "%.1f %s", sec, s));
    }

    static synchronized List<String> snapshot() {
        ArrayList<String> out = new ArrayList<>(lines.size() + 1);
        if (dropped > 0) out.add("… " + dropped + " earlier lines dropped");
        out.addAll(lines);
        return out;
    }
}
