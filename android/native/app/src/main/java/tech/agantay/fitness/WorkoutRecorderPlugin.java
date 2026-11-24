package tech.agantay.fitness;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

/** JS bridge to WorkoutService (background recording) + battery/autostart helpers. */
@CapacitorPlugin(
    name = "WorkoutRecorder",
    permissions = {
        @Permission(alias = "activity", strings = { Manifest.permission.ACTIVITY_RECOGNITION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
    }
)
public class WorkoutRecorderPlugin extends Plugin {

    @Override
    public void load() {
        // the service tells us when an HR session ended on its own (strap taken off) → the web part saves & syncs it now
        WorkoutService.sessionListener = () -> {
            try { notifyListeners("sessionFinished", new JSObject(), true); } catch (Exception ignored) {}
        };
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 29 && getPermissionState("activity") != PermissionState.GRANTED) {
            requestPermissionForAlias("activity", call, "afterActivityPerm");
            return;
        }
        afterActivityPerm(call);
    }

    @PermissionCallback
    private void afterActivityPerm(PluginCall call) {
        boolean wantGps = !Boolean.TRUE.equals(call.getBoolean("resume", false)) && !Boolean.FALSE.equals(call.getBoolean("gps", true));
        if (wantGps && getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "afterLocationPerm");
            return;
        }
        afterLocationPerm(call);
    }

    @PermissionCallback
    private void afterLocationPerm(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "doStart");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void doStart(PluginCall call) {
        Context ctx = getContext();
        Intent i = new Intent(ctx, WorkoutService.class);
        if (Boolean.TRUE.equals(call.getBoolean("resume", false))) {
            i.putExtra("resume", true);
        } else {
            if (WorkoutService.instance == null) WorkoutService.clearSavedState(ctx);
            i.putExtra("cmd", "workout");
            if (call.getString("workoutId") != null) i.putExtra("workoutId", call.getString("workoutId"));
            i.putExtra("postMin", call.getInt("postMin", 90));
            i.putExtra("startedAt", (long) call.getDouble("startedAt", (double) System.currentTimeMillis()).doubleValue());
            i.putExtra("type", call.getString("type", "run"));
            i.putExtra("stride", call.getDouble("stride", 0.75));
            if (call.getString("deviceId") != null) i.putExtra("deviceId", call.getString("deviceId"));
            i.putExtra("gps", !Boolean.FALSE.equals(call.getBoolean("gps", true)));
            if (call.getString("deviceName") != null) i.putExtra("deviceName", call.getString("deviceName"));
        }
        try {
            ContextCompat.startForegroundService(ctx, i);
        } catch (Exception e) {
            call.reject("Не удалось запустить запись в фоне: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("started", true);
        r.put("steps", getPermissionState("activity") == PermissionState.GRANTED || Build.VERSION.SDK_INT < 29);
        r.put("location", getPermissionState("location") == PermissionState.GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void getState(PluginCall call) {
        int since = call.getInt("since", 0);
        WorkoutService s = WorkoutService.instance;
        if (s != null) { call.resolve(toJs(s.state(since, call.getInt("sinceSteps", 0), call.getInt("sinceTrack", 0), call.getInt("sinceSess", 0), call.getInt("sinceRr", 0)))); return; }
        JSONObject saved = WorkoutService.readSavedState(getContext());
        JSObject r = new JSObject();
        r.put("running", false);
        r.put("orphan", saved != null);   // recording interrupted (process killed) — can be resumed
        if (saved != null) { r.put("workoutActive", saved.optBoolean("workoutActive", true)); r.put("phase", saved.optString("phase", "workout")); }
        if (saved != null) r.put("startedAt", saved.optLong("startedAt"));
        call.resolve(r);
    }

    @PluginMethod
    public void setDevice(PluginCall call) {
        WorkoutService s = WorkoutService.instance;
        if (s != null) s.setDevice(call.getString("deviceId"), call.getString("deviceName"));
        call.resolve();
    }

    /** Stop the workout. With keepSession (default) HR monitoring continues for post-run recovery. */
    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        WorkoutService s = WorkoutService.instance;
        if (s != null) {
            JSONObject res = s.finishWorkout(!Boolean.FALSE.equals(call.getBoolean("keepSession", true)));
            call.resolve(toJs(res));
            return;
        }
        JSONObject res = WorkoutService.readSavedState(ctx);
        ctx.stopService(new Intent(ctx, WorkoutService.class));
        WorkoutService.clearSavedState(ctx);
        call.resolve(res != null ? toJs(res) : new JSObject());
    }

    /** Start HR monitoring (before a run) without a workout. */
    @PluginMethod
    public void monitor(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "doMonitor");
            return;
        }
        doMonitor(call);
    }

    @PermissionCallback
    private void doMonitor(PluginCall call) {
        Context ctx = getContext();
        if (WorkoutService.instance != null) {   // already running: maybe a new strap
            WorkoutService.instance.setDevice(call.getString("deviceId"), call.getString("deviceName"));
            call.resolve();
            return;
        }
        WorkoutService.clearSavedState(ctx);
        Intent i = new Intent(ctx, WorkoutService.class).putExtra("cmd", "monitor")
            .putExtra("deviceId", call.getString("deviceId")).putExtra("deviceName", call.getString("deviceName"))
            .putExtra("postMin", call.getInt("postMin", 90));
        try { ContextCompat.startForegroundService(ctx, i); call.resolve(); }
        catch (Exception e) { call.reject("Не удалось запустить мониторинг: " + e.getMessage()); }
    }

    /** End the HR session now (pre-run monitoring or post-run recovery). */
    @PluginMethod
    public void endSession(PluginCall call) {
        WorkoutService s = WorkoutService.instance;
        if (s != null) s.endSession("user");
        call.resolve();
    }

    /** Raw ECG from Polar H10 (PMD service). Needs a running HR session with the strap connected. */
    @PluginMethod
    public void startEcg(PluginCall call) {
        WorkoutService s = WorkoutService.instance;
        if (s == null) { call.reject("сначала подключи пояс (мониторинг пульса)"); return; }
        String err = s.startEcg(call.getInt("seconds", 60));
        if (err != null) call.reject(err); else call.resolve();
    }

    @PluginMethod
    public void stopEcg(PluginCall call) {
        WorkoutService s = WorkoutService.instance;
        if (s != null) s.stopEcg(!Boolean.FALSE.equals(call.getBoolean("save", true)));
        call.resolve();
    }

    /** ECG samples collected so far (for the live preview) from index `since`. */
    @PluginMethod
    public void getEcg(PluginCall call) {
        WorkoutService s = WorkoutService.instance;
        JSObject r = new JSObject();
        if (s == null) { r.put("status", "idle"); call.resolve(r); return; }
        int since = Math.max(0, call.getInt("since", 0));
        synchronized (s) {
            r.put("status", s.ecgStatus); r.put("count", s.ecgCount); r.put("target", s.ecgTarget); r.put("capable", s.ecgCapable);
            r.put("startedAt", s.ecgStartedAt); r.put("since", since);
            org.json.JSONArray a = new org.json.JSONArray();
            int[] buf = s.ecgBufRef();
            for (int i = since; i < s.ecgCount && i < buf.length; i++) a.put(buf[i]);
            r.put("samples", a);
        }
        call.resolve(r);
    }

    /** Short raw-ACC check outside a workout (strap must be connected). */
    @PluginMethod
    public void accTest(PluginCall call) {
        WorkoutService s = WorkoutService.instance;
        if (s == null) { call.reject("мониторинг не запущен"); return; }
        String err = s.startAcc(true, call.getInt("seconds", 30));
        if (err != null) { call.reject(err); return; }
        call.resolve();
    }

    @PluginMethod
    public void listAcc(PluginCall call) {
        JSObject r = new JSObject();
        WorkoutService s = WorkoutService.instance;
        String active = s != null && s.acc != null ? s.acc.id : null;
        org.json.JSONArray a = AccRecorder.list(getContext().getFilesDir());
        try { for (int i = 0; i < a.length(); i++) a.getJSONObject(i).put("active", a.getJSONObject(i).optString("id").equals(active)); } catch (Exception ignored) {}
        r.put("records", a);
        call.resolve(r);
    }

    /** Deflated base64 slice of a raw ACC record: {id, file: "data"|"frames", offset, length} → {b64, crc32 (raw), len}. */
    @PluginMethod
    public void readAccChunk(PluginCall call) {
        try {
            org.json.JSONObject d = call.getData();
            long offset = AccRecorder.argLong(d.opt("offset"), -1);
            int length = (int) AccRecorder.argLong(d.opt("length"), 600000);
            if (offset < 0) { call.reject("offset missing"); return; }
            byte[] raw = AccRecorder.slice(getContext().getFilesDir(), call.getString("id"), call.getString("file", "data"), offset, length);
            JSObject r = new JSObject();
            r.put("b64", android.util.Base64.encodeToString(AccRecorder.deflate(raw), android.util.Base64.NO_WRAP));
            r.put("crc32", AccRecorder.crc32(raw));
            r.put("len", raw.length);
            r.put("offset", offset);
            call.resolve(r);
        } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }

    /** SHA-256 of the whole data.bin / frames.csv, checked by the server at finish. */
    @PluginMethod
    public void accHash(PluginCall call) {
        try {
            java.io.File root = getContext().getFilesDir(); String id = call.getString("id");
            JSObject r = new JSObject();
            r.put("sha256_data", AccRecorder.sha256(AccRecorder.file(root, id, "data")));
            r.put("sha256_frames", AccRecorder.sha256(AccRecorder.file(root, id, "frames")));
            r.put("bytes", AccRecorder.file(root, id, "data").length());
            r.put("frames_bytes", AccRecorder.file(root, id, "frames").length());
            call.resolve(r);
        } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }

    /** Called only after the server confirmed the hashes: the copy moves to acc-uploaded/ and is purged after 7 days. */
    @PluginMethod
    public void deleteAcc(PluginCall call) {
        WorkoutService s = WorkoutService.instance;
        String id = call.getString("id");
        if (s != null && s.acc != null && s.acc.id.equals(id)) { call.reject("запись ещё идёт"); return; }
        boolean test = id != null && id.startsWith("t");
        java.io.File root = getContext().getFilesDir();
        JSObject r = new JSObject(); r.put("ok", test ? AccRecorder.delete(root, id) : AccRecorder.markUploaded(root, id)); call.resolve(r);
    }

    @PluginMethod
    public void takeStrapBattery(PluginCall call) {
        JSObject r = new JSObject();
        r.put("readings", WorkoutService.takeBattery(getContext()));
        WorkoutService s = WorkoutService.instance;
        if (s != null) s.readBattery();
        call.resolve(r);
    }

    @PluginMethod
    public void takeEcgRecords(PluginCall call) {
        JSObject r = new JSObject();
        r.put("records", WorkoutService.takeEcg(getContext()));
        call.resolve(r);
    }

    /** Finished HR sessions not yet picked up by the app (they survive the app being closed). */
    @PluginMethod
    public void takeFinishedSessions(PluginCall call) {
        JSObject r = new JSObject();
        r.put("sessions", WorkoutService.takeFinished(getContext()));
        call.resolve(r);
    }

    // ---- battery optimisation / MIUI autostart ----
    @PluginMethod
    public void batteryStatus(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject r = new JSObject();
        r.put("ignoringOptimizations", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        r.put("miui", isMiui());
        call.resolve(r);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            openAppDetailsInternal();
        }
        call.resolve();
    }

    @PluginMethod
    public void openAutostartSettings(PluginCall call) {
        String[][] targets = {
            { "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" },
            { "com.miui.securitycenter", "com.miui.powercenter.PowerSettings" },
        };
        for (String[] t : targets) {
            try {
                Intent i = new Intent().setComponent(new ComponentName(t[0], t[1])).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve();
                return;
            } catch (Exception ignored) {}
        }
        openAppDetailsInternal();
        call.resolve();
    }

    @PluginMethod
    public void openAppDetails(PluginCall call) { openAppDetailsInternal(); call.resolve(); }

    private void openAppDetailsInternal() {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
    }

    private static boolean isMiui() {
        try {
            Class<?> c = Class.forName("android.os.SystemProperties");
            String v = (String) c.getMethod("get", String.class).invoke(null, "ro.miui.ui.version.name");
            return v != null && !v.isEmpty();
        } catch (Exception e) { return false; }
    }

    private static JSObject toJs(JSONObject o) {
        try { return JSObject.fromJSONObject(o); } catch (Exception e) { return new JSObject(); }
    }
}
