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
        try {
            getActivity().runOnUiThread(() -> {
                if (getActivity() instanceof MainActivity) {
                    ((MainActivity) getActivity()).setOnPushupUnlocked(() -> {
                        try { notifyListeners("pushupUnlocked", new JSObject()); } catch (Exception ignored) {}
                    });
                }
            });
        } catch (Exception ignored) {}
        try {
            getActivity().runOnUiThread(() -> {
                if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).setSessionProbe(() -> pushups != null && pushups.active());
            });
        } catch (Exception ignored) {}
        registerScreenOff();
        recoverPushup();
        setupPullups();
    }

    private android.content.BroadcastReceiver screenOff;
    /** v1.14.1: the power button (screen off) ends the set and saves it, as before; Home / Recents only pause it */
    private void registerScreenOff() {
        if (screenOff != null) return;
        screenOff = new android.content.BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                if (pushups == null || !pushups.active()) return;
                JSONObject set = pushups.finish();
                keepScreenOn(false);
                applyPushupGuard(false);
                JSObject o = new JSObject(); o.put("reason", "screen-off");
                if (set != null) { try { o.put("set", new JSObject(set.toString())); } catch (Exception ignored) {} }
                notifyListeners("pushupFinished", o, true);
            }
        };
        try { getContext().registerReceiver(screenOff, new android.content.IntentFilter(Intent.ACTION_SCREEN_OFF)); }
        catch (Exception e) { screenOff = null; }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        try { if (screenOff != null) getContext().unregisterReceiver(screenOff); } catch (Exception ignored) {}
        screenOff = null;
    }

    /** v1.12: lock or release the full-screen touch guard for a push-up set. */
    private void applyPushupGuard(boolean on) { applyPushupGuard(on, true); }

    private void applyPushupGuard(boolean on, boolean locked) {
        try {
            getActivity().runOnUiThread(() -> {
                if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).setPushupGuard(on, locked);
            });
        } catch (Exception ignored) {}
    }

    @PluginMethod
    public void setPushupGuard(PluginCall call) {
        applyPushupGuard(call.getBoolean("on", false), call.getBoolean("locked", true));
        call.resolve();
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

    // ---- v1.9 smart scale (Xiaomi Mi Body Composition Scale 2) ----
    private ScaleScanner liveScale;
    private final android.os.Handler scaleHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable scaleTimeout = this::stopLiveScale;

    /** live scan for the «Взвеситься» screen; refused while a workout is being recorded. Stops itself after 3 min. */
    @PluginMethod
    public void scaleStart(PluginCall call) {
        WorkoutService s = WorkoutService.instance;
        if (s != null && s.workoutActive) { call.reject("Идёт запись тренировки", "recording"); return; }
        if (liveScale == null) {
            liveScale = new ScaleScanner(getContext(), false);
            liveScale.setListener((r, dev, saved) -> {
                JSObject o = new JSObject();
                o.put("weight_kg", r.weightKg); o.put("impedance", r.impedance); o.put("stable", r.stable);
                o.put("removed", r.removed); o.put("final", r.isFinal()); o.put("saved", saved); o.put("unit", r.unit);
                o.put("id", r.key()); o.put("scale_time", r.scaleTime());
                notifyListeners("scale", o);
            });
        }
        String err = liveScale.start();
        if (err != null) { call.reject(err, err); return; }
        scaleHandler.removeCallbacks(scaleTimeout);
        scaleHandler.postDelayed(scaleTimeout, 180_000);
        call.resolve();
    }

    private void stopLiveScale() {
        scaleHandler.removeCallbacks(scaleTimeout);
        if (liveScale != null) liveScale.stop();
        notifyListeners("scaleStopped", new JSObject());
    }

    @PluginMethod
    public void scaleStop(PluginCall call) { stopLiveScale(); call.resolve(); }

    // ---- v1.10 push-up counter (proximity sensor, voice count on every rep) ----
    private PushupSession pushups;

    private void keepScreenOn(boolean on) {
        try {
            getActivity().runOnUiThread(() -> {
                if (on) getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        } catch (Exception ignored) {}
    }

    private PushupSession pushupSession() {
        if (pushups == null) {
            pushups = new PushupSession(getContext());
            pushups.setListener(new PushupSession.Listener() {
                @Override public void onState(JSONObject st) {
                    try { notifyListeners("pushup", new JSObject(st.toString())); } catch (Exception ignored) {}
                }
                @Override public void onRep(int reps, boolean undo) {
                    JSObject o = new JSObject(); o.put("reps", reps); o.put("undo", undo); o.put("countdown", 0); o.put("counting", true);
                    notifyListeners("pushup", o);
                }
                @Override public void onAutoFinished(JSONObject set, String reason) {
                    keepScreenOn(false);
                    applyPushupGuard(false);
                    JSObject o = new JSObject(); o.put("reason", reason);
                    if (set != null) { try { o.put("set", new JSObject(set.toString())); } catch (Exception ignored) {} }
                    notifyListeners("pushupFinished", o, true);
                }
            });
        }
        return pushups;
    }

    @PluginMethod
    public void pushupInfo(PluginCall call) {
        PushupSession p = pushupSession();
        JSObject r = new JSObject();
        r.put("present", p.present()); r.put("maxRange", p.maxRange()); r.put("sensor", p.sensorName());
        r.put("binary", p.maxRange() <= 5.5f); r.put("voice", p.voiceClips()); r.put("active", p.active());
        r.put("paused", p.paused()); r.put("reps", p.reps());
        r.put("countdown", p.countdownLeft()); r.put("counting", p.counting());
        try { if (getActivity() instanceof MainActivity) r.put("guard", ((MainActivity) getActivity()).guardState()); } catch (Exception ignored) {}
        WorkoutService s = WorkoutService.instance;
        r.put("recording", s != null && s.workoutActive);
        call.resolve(r);
    }

    /** start a set with the same native countdown as pull-ups (default 8 s); refused while a workout is recorded */
    @PluginMethod
    public void pushupStart(PluginCall call) {
        WorkoutService s = WorkoutService.instance;
        if (s != null && s.workoutActive) { call.reject("Идёт запись тренировки", "recording"); return; }
        if (PullupSession.get(getContext()).active()) { call.reject("Идёт подход подтягиваний", "pullups"); return; }
        String err = pushupSession().start(call.getInt("countdown", 8));
        if (err != null) { call.reject(err, err); return; }
        keepScreenOn(true);
        call.resolve();
    }

    @PluginMethod
    public void pushupUndo(PluginCall call) {
        if (pushups != null) pushups.undo();
        call.resolve();
    }

    /** end the set; resolves with {set} (null if nothing was counted) */
    @PluginMethod
    public void pushupFinish(PluginCall call) {
        JSObject r = new JSObject();
        if (pushups != null) {
            JSONObject set = pushups.finish();
            if (set != null) { try { r.put("set", new JSObject(set.toString())); } catch (Exception ignored) {} }
        }
        keepScreenOn(false);
        applyPushupGuard(false);
        call.resolve(r);
    }

    // ---- v1.17 pull-up counter (phone accelerometer; works with the screen off, in a pocket or on the neck) ----
    private void setupPullups() {
        try {
            PullupSession p = PullupSession.get(getContext());
            p.setListener(new PullupSession.Listener() {
                @Override public void onState(JSONObject st) {
                    try { notifyListeners("pullup", new JSObject(st.toString())); } catch (Exception ignored) {}
                }
                @Override public void onFinished(JSONObject set, String reason) {
                    JSObject o = new JSObject(); o.put("reason", reason);
                    if (set != null) { try { o.put("set", new JSObject(lite(set).toString())); } catch (Exception ignored) {} }
                    notifyListeners("pullupFinished", o, true);
                }
            });
            JSONObject left = PullupSession.recoverLeftover(getContext());
            if (left != null) {
                JSObject o = new JSObject(); o.put("reason", "recovered");
                try { o.put("set", new JSObject(left.toString())); } catch (Exception ignored) {}
                notifyListeners("pullupFinished", o, true);
            }
        } catch (Exception ignored) {}
    }

    /** the set without its raw block (the raw goes through takePullupSets only) */
    private static JSONObject lite(JSONObject set) {
        try { JSONObject c = new JSONObject(set.toString()); c.remove("raw"); return c; } catch (Exception e) { return set; }
    }

    @PluginMethod
    public void pullupInfo(PluginCall call) {
        PullupSession p = PullupSession.get(getContext());
        JSObject r;
        try { r = new JSObject(p.state().toString()); } catch (Exception e) { r = new JSObject(); }
        r.put("present", p.present());
        try { r.put("sensor", new JSObject(p.sensorInfo().toString())); } catch (Exception ignored) {}
        WorkoutService s = WorkoutService.instance;
        r.put("recording", s != null && s.workoutActive);
        r.put("pushups", pushups != null && pushups.active());
        call.resolve(r);
    }

    @PluginMethod
    public void pullupStart(PluginCall call) {
        WorkoutService s = WorkoutService.instance;
        if (s != null && s.workoutActive) { call.reject("Идёт запись тренировки", "recording"); return; }
        if (pushups != null && pushups.active()) { call.reject("Идёт подход отжиманий", "pushups"); return; }
        String err = PullupSession.get(getContext()).start(call.getInt("countdown", 8));
        if (err != null) { call.reject(err, err); return; }
        call.resolve();
    }

    @PluginMethod
    public void pullupUndo(PluginCall call) { PullupSession.get(getContext()).undo(); call.resolve(); }

    /** end the set now; resolves with {set} without raw (null if nothing was counted) */
    @PluginMethod
    public void pullupFinish(PluginCall call) {
        JSObject r = new JSObject();
        JSONObject set = PullupSession.get(getContext()).finish(call.getString("reason", "app"));
        if (set != null) { try { r.put("set", new JSObject(lite(set).toString())); } catch (Exception ignored) {} }
        call.resolve(r);
    }

    /** finished sets with raw accelerometer, emptied after reading */
    @PluginMethod
    public void takePullupSets(PluginCall call) {
        JSObject r = new JSObject();
        r.put("sets", PullupStore.take(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void takePushupSets(PluginCall call) {
        JSObject r = new JSObject();
        r.put("sets", PushupStore.take(getContext()));
        call.resolve(r);
    }

    /**
     * v1.14: the proximity sensor is silent in the background (Recents, Home, screen off). Pause the set — do not
     * finish it. The 2-minute idle close still runs; coming back in handleOnResume continues the same set.
     */
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (pushups != null && pushups.active() && !pushups.paused()) {
            pushups.pause();
            keepScreenOn(false);
            applyPushupGuard(false);
            JSObject o = new JSObject(); o.put("reps", pushups.reps()); o.put("paused", true);
            notifyListeners("pushupPaused", o, true);
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        recoverPushup();
        if (pushups != null && pushups.paused()) {
            boolean cold = pushups.takeRestored();   // the app was killed meanwhile: open usable, never locked
            String err = pushups.resume();
            if (err != null) return;
            keepScreenOn(true);
            applyPushupGuard(true, !cold);
            JSObject o = new JSObject(); o.put("reps", pushups.reps()); o.put("resumed", true); o.put("locked", !cold);
            o.put("countdown", pushups.countdownLeft()); o.put("counting", pushups.counting());
            notifyListeners("pushupResumed", o, true);
        }
    }

    /** after a process / activity death: close an expired leftover, or bring a still-open set back as paused */
    private void recoverPushup() {
        try {
            android.content.Context ctx = getContext();
            if (ctx == null) return;
            if (pushups != null && pushups.active()) return;
            JSONObject closed = PushupLive.closeIfExpired(ctx, System.currentTimeMillis());
            if (closed != null) {
                JSObject o = new JSObject(); o.put("reason", "idle");
                try { o.put("set", new JSObject(closed.toString())); } catch (Exception ignored) {}
                notifyListeners("pushupFinished", o, true);
                return;
            }
            JSONObject live = PushupLive.read(ctx);
            if (live == null) return;
            pushupSession().restore(live);
        } catch (Exception ignored) {}
    }

    @PluginMethod
    public void takeScaleReadings(PluginCall call) {
        JSObject r = new JSObject();
        r.put("readings", ScaleStore.take(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void scaleConfig(PluginCall call) {
        if (call.getData().has("passive")) WorkoutService.setScalePassive(getContext(), call.getBoolean("passive", true));
        WorkoutService s = WorkoutService.instance;
        if (s != null) s.syncScaleScan();
        JSObject r = new JSObject();
        r.put("passive", WorkoutService.scalePassiveOn(getContext()));
        r.put("permitted", ScaleScanner.permitted(getContext()));
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

    // ---- v1.8 voice announcements ----
    @PluginMethod
    public void setVoice(PluginCall call) {
        VoiceSpeaker.saveCfg(getContext(), call.getData());
        call.resolve(toJs(VoiceSpeaker.get(getContext()).info()));
    }
    @PluginMethod
    public void voiceInfo(PluginCall call) {
        VoiceSpeaker sp = VoiceSpeaker.get(getContext()); sp.ensure();
        call.resolve(toJs(sp.info()));
    }
    @PluginMethod
    public void voiceTest(PluginCall call) {
        VoiceSpeaker sp = VoiceSpeaker.get(getContext());
        sp.sayNow(RunPhrases.test());
        call.resolve(toJs(sp.info()));
    }
    /** at «Стоп» of a run: the app passes the numbers of the saved record (distance, moving time, pace, average HR) */
    @PluginMethod
    public void announceFinish(PluginCall call) {
        RunVoice.Cfg c = VoiceSpeaker.loadCfg(getContext());
        JSONObject d = call.getData();
        if (c.enabled && c.events && "run".equals(d.optString("type", "run"))) {
            VoiceSpeaker.get(getContext()).sayNow(RunPhrases.finish((int) Math.round(d.optDouble("distance_m", 0)), (int) Math.round(d.optDouble("moving_s", 0)),
                (int) Math.round(d.optDouble("pace_s_km", 0)), (int) Math.round(d.optDouble("hr_avg", 0))));
        }
        call.resolve();
    }
    /** Workouts the service closed by itself (forgotten «Стоп»); handed over once, they survive the app being closed. */
    @PluginMethod
    public void takeAutoEnded(PluginCall call) {
        JSObject r = new JSObject();
        r.put("workouts", WorkoutService.takeAutoEnded(getContext()));
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
