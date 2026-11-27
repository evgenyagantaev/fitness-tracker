package tech.agantay.fitness;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** v1.17: finished pull-up sets (with their raw accelerometer) waiting for the web part; survives the app being closed. */
final class PullupStore {
    static final String FILE = "pullup-pending.json";
    static final int KEEP = 40;   // a set with raw data is ~50–300 KB
    private PullupStore() {}

    static boolean merge(JSONArray a, JSONObject set) {
        String id = set.optString("id");
        if (id.isEmpty()) return false;
        for (int i = 0; i < a.length(); i++) if (id.equals(a.optJSONObject(i).optString("id"))) return false;
        a.put(set);
        while (a.length() > KEEP) a.remove(0);
        return true;
    }

    static synchronized boolean add(Context ctx, JSONObject set) {
        JSONArray a = read(ctx);
        if (!merge(a, set)) return false;
        write(ctx, a);
        return true;
    }

    static synchronized JSONArray read(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), FILE);
            if (!f.exists()) return new JSONArray();
            byte[] b = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) { int n = in.read(b); }
            return new JSONArray(new String(b, StandardCharsets.UTF_8));
        } catch (Exception e) { return new JSONArray(); }
    }

    private static void write(Context ctx, JSONArray a) {
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), FILE))) { out.write(a.toString().getBytes(StandardCharsets.UTF_8)); }
        catch (Exception ignored) {}
    }

    static synchronized JSONArray take(Context ctx) {
        JSONArray a = read(ctx);
        if (a.length() > 0) write(ctx, new JSONArray());
        return a;
    }

    // ---- the set in progress (count only), so a process death does not lose it ----
    static final String LIVE = "pullup-live.json";

    static synchronized void writeLive(Context ctx, JSONObject o) {
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), LIVE))) { out.write(o.toString().getBytes(StandardCharsets.UTF_8)); }
        catch (Exception ignored) {}
    }
    static synchronized JSONObject readLive(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), LIVE);
            if (!f.exists()) return null;
            byte[] b = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) { int n = in.read(b); }
            return b.length == 0 ? null : new JSONObject(new String(b, StandardCharsets.UTF_8));
        } catch (Exception e) { return null; }
    }
    static synchronized void clearLive(Context ctx) { try { new File(ctx.getFilesDir(), LIVE).delete(); } catch (Exception ignored) {} }
}
