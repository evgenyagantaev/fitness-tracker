package tech.agantay.fitness;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Final weighings waiting for the app to send them to the server (survives the app being closed). */
final class ScaleStore {
    static final String FILE = "scale-pending.json";
    private ScaleStore() {}

    /** pure merge used by add(): new key → append; same key → only fill in a missing impedance. @return true if changed */
    static boolean merge(JSONArray a, JSONObject w) {
        try {
            String id = w.getString("id");
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                if (id.equals(o.optString("id"))) {
                    if (o.optInt("impedance", 0) == 0 && w.optInt("impedance", 0) > 0) { o.put("impedance", w.getInt("impedance")); return true; }
                    return false;
                }
            }
            a.put(w);
            while (a.length() > 300) a.remove(0);
            return true;
        } catch (Exception e) { return false; }
    }

    static JSONObject toJson(MiScale.Reading r, long now, String device) {
        try {
            JSONObject o = new JSONObject().put("id", r.key()).put("t", now).put("weight_kg", r.weightKg)
                .put("scale_time", r.scaleTime()).put("unit", r.unit).put("source", "mi-scale-2");
            if (r.impedance > 0) o.put("impedance", r.impedance);
            if (device != null) o.put("device", device);
            return o;
        } catch (Exception e) { return null; }
    }

    static synchronized boolean add(Context ctx, MiScale.Reading r, String device) {
        JSONObject o = toJson(r, System.currentTimeMillis(), device);
        if (o == null) return false;
        JSONArray a = read(ctx);
        if (!merge(a, o)) return false;
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
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), FILE))) {
            out.write(a.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }

    /** handed to the app; it keeps its own copy until the server confirmed */
    static synchronized JSONArray take(Context ctx) {
        JSONArray a = read(ctx);
        new File(ctx.getFilesDir(), FILE).delete();
        return a;
    }
}
