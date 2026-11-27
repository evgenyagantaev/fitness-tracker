package tech.agantay.fitness;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Random;

/**
 * v1.14: the push-up set in progress, written to disk so it survives the activity (or the process) being
 * killed after Recents / Home. Not a finished set — those go to {@link PushupStore}.
 */
final class PushupLive {
    static final String FILE = "pushup-live.json";
    private PushupLive() {}

    /**
     * the set is older than the idle limit (wall clock: used after a process death / reboot). A leftover is never brought back locked:
     * it is either closed and saved right away (this) or picked up unlocked.
     */
    static boolean expired(JSONObject live, long nowWall) {
        if (live == null) return false;
        long last = Math.max(live.optLong("lastRepWall", 0), live.optLong("startedAt", 0));
        return last > 0 && nowWall - last > PushupSession.IDLE_END_MS;
    }

    /** a finished-set record from a live snapshot (null if there were no reps) */
    static JSONObject toSet(JSONObject live, long nowWall) {
        if (live == null) return null;
        int n = live.optInt("reps");
        if (n < 1) return null;
        try {
            long startedAt = live.optLong("startedAt", nowWall);
            long first = live.optLong("firstRepWall", startedAt);
            long last = live.optLong("lastRepWall", nowWall);
            double dur = n < 2 ? 0 : Math.max(0, (last - first) / 1000.0);
            double armed = Math.max(0, (nowWall - startedAt) / 1000.0);
            return new JSONObject()
                .put("id", live.optString("id", String.format(Locale.ROOT, "pu-%d-%03d", startedAt, new Random().nextInt(1000))))
                .put("t", startedAt).put("reps", n)
                .put("duration_s", Math.round(dur * 10) / 10.0)
                .put("armed_s", Math.round(armed * 10) / 10.0)
                .put("source", "proximity");
        } catch (Exception e) { return null; }
    }

    static synchronized JSONObject read(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), FILE);
            if (!f.exists()) return null;
            byte[] b = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) { in.read(b); }
            if (b.length == 0) return null;
            return new JSONObject(new String(b, StandardCharsets.UTF_8));
        } catch (Exception e) { return null; }
    }

    static synchronized void write(Context ctx, JSONObject live) {
        if (live == null) { clear(ctx); return; }
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), FILE))) {
            out.write(live.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }

    static synchronized void clear(Context ctx) {
        try { new File(ctx.getFilesDir(), FILE).delete(); } catch (Exception ignored) {}
    }

    /** if a leftover live set has expired, store it as finished and drop the snapshot; @return the set or null */
    static synchronized JSONObject closeIfExpired(Context ctx, long nowWall) {
        JSONObject live = read(ctx);
        if (live == null || !expired(live, nowWall)) return null;
        JSONObject set = toSet(live, nowWall);
        if (set != null) PushupStore.add(ctx, set);
        clear(ctx);
        return set;
    }
}
