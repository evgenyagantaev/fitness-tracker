package tech.agantay.fitness;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Finished push-up sets waiting for the web part to put them on the board and send them to the server (survives the app being closed). */
final class PushupStore {
    static final String FILE = "pushup-pending.json";
    private PushupStore() {}

    /** pure: append unless the id is already there; keeps at most 300 */
    static boolean merge(JSONArray a, JSONObject set) {
        String id = set.optString("id");
        if (id.isEmpty()) return false;
        for (int i = 0; i < a.length(); i++) if (id.equals(a.optJSONObject(i).optString("id"))) return false;
        a.put(set);
        while (a.length() > 300) a.remove(0);
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

    /** hand everything over and empty the file */
    static synchronized JSONArray take(Context ctx) {
        JSONArray a = read(ctx);
        if (a.length() > 0) write(ctx, new JSONArray());
        return a;
    }
}
