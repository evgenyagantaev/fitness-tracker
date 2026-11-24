package tech.agantay.fitness;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.SystemClock;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;

/**
 * Foreground service that records a workout while the screen is off / app is in background:
 * timer, BLE heart rate (0x180D / 0x2A37) and phone step counter. State is mirrored to a file
 * so a restarted process can resume. The JS side polls state through WorkoutRecorderPlugin.
 */
public class WorkoutService extends Service implements SensorEventListener {
    static final String TAG = "WorkoutService";
    static final String CHANNEL = "workout";
    static final int NOTIF_ID = 4242;
    static final UUID HRS = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb");
    static final UUID HRM = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb");
    static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    static final String STATE_FILE = "workout-state.json";
    static final String FINISHED_FILE = "hr-sessions-finished.json";
    static final long PRE_MAX_MS = 2 * 60 * 60 * 1000L;      // monitoring before a start: at most 2 h
    static final long PRE_NO_HR_MS = 10 * 60 * 1000L;       // strap silent for 10 min before a start -> end
    static final long POST_NO_HR_MS = 3 * 60 * 1000L;       // strap taken off after the run -> end

    static volatile WorkoutService instance;

    // recorded state (guarded by this)
    long startedAt;
    String type = "run", deviceId, deviceName;
    double stride = 0.75;
    final ArrayList<int[]> samples = new ArrayList<>();
    float stepBase = -1; int stepsBefore = 0; int steps = 0; long stepTotal = -1;
    int bpm = 0; long bpmAt = 0;
    String hrStatus = "none";   // none | connecting | connected | disconnected | error:<msg>
    // step series: [sec since start, cumulative steps] (≤1 point/s) — used for cadence, stops, 100-step segments
    final ArrayList<int[]> stepSeries = new ArrayList<>();
    // GPS track: [sec, lat, lon, accuracy m]
    final ArrayList<double[]> track = new ArrayList<>();
    boolean useGps = true;
    String gpsStatus = "off";    // off | no-permission | disabled | searching | ok
    double gpsDist = 0, gpsAcc = 0, gpsSpeed = 0; long gpsAt = 0;
    private double[] gpsAnchor = null;
    // HR session: spans pre-run monitoring, the workout(s) and post-run recovery
    long sessionStart = 0, workoutEnd = 0, lastHrAt = 0;
    String phase = "pre";        // pre | workout | post
    boolean workoutActive = false;
    String workoutId = null;
    int postMin = 90;
    final ArrayList<int[]> sess = new ArrayList<>();          // [sec since sessionStart, bpm]
    final JSONArray sessWorkouts = new JSONArray();          // [{id, startedAt, endedAt}]
    private final ArrayList<double[]> recent = new ArrayList<>();   // last point that was counted into gpsDist

    private Handler handler;
    private PowerManager.WakeLock wakeLock;
    private SensorManager sm;
    private BluetoothGatt gatt;
    private boolean running = false;
    private int reconnectDelay = 2000;
    private LocationManager lm;

    static String typeLabel(String t) {
        if ("walk".equals(t)) return "Ходьба";
        if ("workout".equals(t)) return "Тренировка";
        return "Бег";
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        sm = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Запись тренировки", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Идёт запись тренировки");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String cmd = intent == null || intent.getBooleanExtra("resume", false) ? "resume"
            : (intent.getStringExtra("cmd") != null ? intent.getStringExtra("cmd") : "workout");
        if ("autoend".equals(cmd)) {
            if (running) autoEndWorkout(intent.getIntExtra("endSec", -1), "user");
            return START_STICKY;
        }
        if ("end".equals(cmd)) {
            if (running) endSession("user"); else stopSelf();
            return START_NOT_STICKY;
        }
        boolean beganWorkout = false; String newDevice = null, newName = null;
        synchronized (this) {
            if ("resume".equals(cmd)) {
                if (!running && !loadState()) { stopSelf(); return START_NOT_STICKY; }
            } else {
                long now = System.currentTimeMillis();
                if (!running) {   // new HR session
                    sessionStart = "workout".equals(cmd) ? intent.getLongExtra("startedAt", now) : now;
                    sess.clear(); rr.clear(); while (sessWorkouts.length() > 0) sessWorkouts.remove(0);
                    phase = "pre"; workoutActive = false; workoutEnd = 0; workoutId = null; lastHrAt = now;
                    deviceId = intent.getStringExtra("deviceId"); deviceName = intent.getStringExtra("deviceName");
                    bpm = 0; bpmAt = 0; hrStatus = "none";
                    samples.clear(); stepSeries.clear(); track.clear(); steps = 0; gpsDist = 0;
                } else if (intent.getStringExtra("deviceId") != null && !intent.getStringExtra("deviceId").equals(deviceId)) {
                    newDevice = intent.getStringExtra("deviceId"); newName = intent.getStringExtra("deviceName");
                }
                postMin = intent.getIntExtra("postMin", postMin);
                if ("workout".equals(cmd) && !workoutActive) { beginWorkout(intent); beganWorkout = true; }
            }
        }
        startInForeground();
        if (!running) {
            running = true;
            instance = this;
            acquireWakeLock();
            startSteps();   // whole HR session: the counter is warm at «Старт», so the first steps are not lost
            if (workoutActive) startGps();
            if (workoutActive && deviceId == null) handler.post(() -> startAcc(false, 0));   // beltless run resumed after the process died
            connectHr();
            handler.post(ticker);
        } else if (beganWorkout) {
            startSteps(); startGps();
        }
        if (newDevice != null) setDevice(newDevice, newName);
        saveState();
        return START_STICKY;
    }

    private void beginWorkout(Intent intent) {
        startedAt = intent.getLongExtra("startedAt", System.currentTimeMillis());
        type = intent.getStringExtra("type") != null ? intent.getStringExtra("type") : "run";
        stride = intent.getDoubleExtra("stride", 0.75);
        useGps = intent.getBooleanExtra("gps", true);
        workoutId = intent.getStringExtra("workoutId");
        if (deviceId == null) { deviceId = intent.getStringExtra("deviceId"); deviceName = intent.getStringExtra("deviceName"); }
        samples.clear(); stepsBefore = 0; steps = 0;
        // anchor at «Старт»: steps made before the counter's next (batched) event still count
        stepBase = stepTotal >= 0 ? stepTotal : -1;
        stepSeries.clear(); track.clear(); gpsDist = 0; gpsAnchor = null; gpsAcc = 0; gpsSpeed = 0; gpsAt = 0; recent.clear();
        workoutActive = true; phase = "workout"; workoutEnd = 0;
        handler.post(() -> startAcc(false, 0));
    }

    private void startInForeground() {
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            int t = 0;
            if (Build.VERSION.SDK_INT >= 34) {
                if (granted(Manifest.permission.ACTIVITY_RECOGNITION)) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH;
                if (deviceId != null && granted(Manifest.permission.BLUETOOTH_CONNECT)) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
                if (workoutActive && useGps && locationGranted()) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
                if (t == 0) t = ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH;
            } else {
                t = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;   // manifest types, fine on 29–33
                if (workoutActive && useGps && locationGranted()) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            }
            try { startForeground(NOTIF_ID, n, t); }
            catch (Exception e) { Log.w(TAG, "startForeground typed failed", e); startForeground(NOTIF_ID, n); }
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private boolean locationGranted() {
        return granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    private boolean granted(String p) {
        return ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED;
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String hr;
        synchronized (this) {
            boolean fresh = bpm > 0 && System.currentTimeMillis() - bpmAt < 8000;
            hr = fresh ? "♥ " + bpm : (deviceId == null ? "без пульсометра" : ("connected".equals(hrStatus) ? "♥ —" : "♥ нет связи"));
        }
        double km; String src;
        synchronized (this) {
            boolean gpsGood = "ok".equals(gpsStatus) && gpsDist > 50;
            km = (gpsGood ? gpsDist : steps * stride) / 1000.0; src = gpsGood ? " GPS" : "";
        }
        double secs = (System.currentTimeMillis() - startedAt) / 1000.0;
        String pace = km > 0.05 ? String.format(Locale.US, " · %d:%02d/км", (int) (secs / km) / 60, (int) (secs / km) % 60) : "";
        String text, title; long when;
        if ("workout".equals(phase)) {
            title = "Идёт запись: " + typeLabel(type); when = startedAt;
            text = String.format(Locale.forLanguageTag("ru"), "%s · %d шагов · %.2f км%s%s", hr, steps, km, src, pace);
        } else if ("post".equals(phase)) {
            title = "Восстановление пульса"; when = workoutEnd;
            long left = Math.max(0, (workoutEnd + postMin * 60000L - System.currentTimeMillis()) / 60000L);
            text = hr + " · после финиша · запись ещё до " + left + " мин или пока пояс не снят";
        } else {
            title = "Мониторинг пульса"; when = sessionStart;
            text = hr + " · до старта тренировки";
        }
        PendingIntent endPi = PendingIntent.getService(this, 2, new Intent(this, WorkoutService.class).putExtra("cmd", "end"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder nb = new NotificationCompat.Builder(this, CHANNEL);
        if (!"workout".equals(phase)) nb.addAction(0, "Завершить мониторинг", endPi);
        return nb
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setWhen(when).setUsesChronometer(true).setShowWhen(true)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_WORKOUT)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(pi)
            .build();
    }

    /**
     * When the HR session ends by itself. lastHrAt only moves on a *valid* beat (25–250 bpm, skin contact), so taking the strap
     * off ends the session whether the strap disconnects (reconnect attempts don't count as data) or stays connected sending
     * HR=0 / "no contact".
     */
    static String endReason(String phase, long now, long sessionStart, long workoutEnd, long lastHrAt, int postMin, boolean hasDevice) {
        if ("pre".equals(phase)) {
            if (now - sessionStart > PRE_MAX_MS) return "pre-timeout";
            if (hasDevice && now - lastHrAt > PRE_NO_HR_MS) return "no-hr";
        } else if ("post".equals(phase)) {
            if (now - workoutEnd > postMin * 60000L) return "post-done";
            if (now - lastHrAt > POST_NO_HR_MS) return "strap-off";
        }
        return null;
    }

    /** Valid beat? HR in range and — if the strap reports contact — skin contact detected (flags bit2 supported, bit1 detected). */
    static boolean validBeat(int flags, int value) {
        boolean contactSupported = (flags & 0x04) != 0, contact = (flags & 0x02) != 0;
        return value >= 25 && value <= 250 && (!contactSupported || contact);
    }

    /**
     * Beat times for one HR notification: the last RR ends at the notification time, earlier ones before it — but never
     * before (previous beat + this RR), so times stay monotonic (BLE delivery jitter), and never after now.
     */
    static final long RR_REALIGN_MS = 2000;
    /**
     * v1.6.1: beat times form a continuous chain (previous beat + RR), so successive beats are exactly RR apart.
     * The chain is re-aligned to the notification time (last beat = now, earlier ones before it) only when it has
     * drifted more than 2 s from it (dropped notifications, reconnects) — not on every notification, which used
     * to squeeze 13 % of beats together (24.11). Always monotonic.
     */
    static long[] beatTimes(java.util.List<Integer> rrs, long nowRel, long prevBeat) {
        int n = rrs.size(); long[] ts = new long[n];
        if (n == 0) return ts;
        boolean realign = prevBeat == Long.MIN_VALUE;
        if (!realign) {
            long t = prevBeat;
            for (int i = 0; i < n; i++) { t += rrs.get(i); ts[i] = t; }
            if (Math.abs(nowRel - ts[n - 1]) > RR_REALIGN_MS) realign = true;
        }
        if (realign) {
            long t = nowRel;
            for (int i = n - 1; i >= 0; i--) { ts[i] = t; t -= rrs.get(i); }
            long prev = prevBeat;
            for (int i = 0; i < n; i++) {
                if (prev != Long.MIN_VALUE && ts[i] <= prev) ts[i] = prev + 1;
                prev = ts[i];
            }
        }
        return ts;
    }

    /** Strap taken off: cut ≥ OFF_TRIM_S before the last valid beat, earlier if a cluster of artefact beats starts before that. */
    static final int OFF_TRIM_S = 20;
    static long tailCutRel(java.util.List<int[]> rr, long lastRel) {
        long cut = lastRel - OFF_TRIM_S * 1000L;
        int n = rr.size(); if (n < 20) return cut;
        int i0 = n - 1; while (i0 > 10 && rr.get(i0 - 1)[0] >= lastRel - 90000) i0--;
        for (int j = i0; j < n; j++) {
            if (!rrArtifact(rr, j)) continue;
            int bad = 0, all = 0; for (int k = j; k < n; k++) { all++; if (rrArtifact(rr, k)) bad++; }
            int near = 0; for (int k = j; k < Math.min(n, j + 5); k++) if (rrArtifact(rr, k)) near++;
            if (near >= 2 && bad * 10 >= all * 4) { cut = Math.min(cut, rr.get(j)[0] - rr.get(j)[1]); break; }
        }
        return cut;
    }
    static boolean rrArtifact(java.util.List<int[]> rr, int j) {
        int v = rr.get(j)[1]; if (v < 300 || v > 2000) return true;
        int[] prev = new int[8]; int m = 0;
        for (int k = j - 1; k >= 0 && m < 8; k--) { int u = rr.get(k)[1]; if (u >= 300 && u <= 2000) prev[m++] = u; }
        if (m == 0) return false;
        int[] s = java.util.Arrays.copyOf(prev, m); java.util.Arrays.sort(s);
        double med = m % 2 == 1 ? s[m / 2] : (s[m / 2 - 1] + s[m / 2]) / 2.0;
        return Math.abs(v - med) > 0.25 * med;
    }

    private int tickCount = 0;
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (!running) return;
            tickCount++;
            if (tickCount % 3 == 0) {
                try { getSystemService(NotificationManager.class).notify(NOTIF_ID, buildNotification()); } catch (Exception ignored) {}
            }
            if (tickCount % 10 == 0) saveState();
            if (tickCount % 600 == 0) readBattery();
            if (tickCount % 5 == 0) { AccRecorder r = acc; if (r != null) r.flush(); }
            if (tickCount % 30 == 0) checkForgottenStop();
            long now = System.currentTimeMillis();
            if (accTest && accTestUntil > 0 && now > accTestUntil + 3000) stopAcc(true);
            String reason;
            synchronized (WorkoutService.this) {
                reason = endReason(phase, now, sessionStart, workoutEnd, lastHrAt, postMin, deviceId != null);
            }
            if (reason != null) { endSession(reason); return; }
            handler.postDelayed(this, 1000);
        }
    };

    @SuppressLint("WakelockTimeout")
    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fitness:workout");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(6 * 60 * 60 * 1000L);   // safety cap 6 h
    }

    // ---------------- forgot to press «Стоп» (v1.7) ----------------
    static final String ALERT_CHANNEL = "workout-alert", AUTOEND_FILE = "auto-ended.json";
    static final int ALERT_ID = NOTIF_ID + 2;
    private boolean forgotNotified = false;
    private void checkForgottenStop() {
        RunEnd.Verdict v; int endSec;
        synchronized (this) {
            if (!workoutActive || !"run".equals(type)) return;
            int now = (int) ((System.currentTimeMillis() - startedAt) / 1000);
            v = RunEnd.verdict(stepSeries, track, samples, deviceId != null, now);
            endSec = v.lastRunSec;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (!v.ran || !v.notify) { if (forgotNotified) { nm.cancel(ALERT_ID); forgotNotified = false; } return; }
        if (v.close) { Log.i(TAG, "forgotten stop: closing the workout at +" + endSec + " s"); nm.cancel(ALERT_ID); forgotNotified = false; autoEndWorkout(endSec, "auto"); return; }
        if (forgotNotified) return;
        forgotNotified = true;
        try {
            if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(ALERT_CHANNEL) == null)
                nm.createNotificationChannel(new NotificationChannel(ALERT_CHANNEL, "Забытый «Стоп»", NotificationManager.IMPORTANCE_DEFAULT));
            String hhmm = new java.text.SimpleDateFormat("HH:mm", Locale.getDefault()).format(new java.util.Date(startedAt + endSec * 1000L));
            PendingIntent yes = PendingIntent.getService(this, 3, new Intent(this, WorkoutService.class).putExtra("cmd", "autoend").putExtra("endSec", endSec),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, 4, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            nm.notify(ALERT_ID, new NotificationCompat.Builder(this, ALERT_CHANNEL).setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle("Похоже, пробежка закончилась в " + hhmm + ". Завершить?")
                .setContentText("Запись продолжается. Если ничего не нажимать, она закроется сама, данные сохранятся.")
                .addAction(0, "Завершить", yes).setContentIntent(pi).setAutoCancel(true).build());
        } catch (Exception e) { Log.w(TAG, "forgot notification", e); }
    }

    /**
     * Finish the workout at the detected end (last running second + 20 s). Nothing is thrown away: the snapshot handed to the app is cut
     * at that point, everything recorded after it travels along as `tail` and is stored with the workout.
     */
    void autoEndWorkout(int endSec, String why) {
        JSONObject snap;
        long endMs;
        boolean end;
        synchronized (this) {
            if (!workoutActive) return;
            long now = System.currentTimeMillis();
            int nowSec = (int) ((now - startedAt) / 1000);
            if (endSec < 0 || endSec > nowSec) endSec = nowSec;
            int cut = Math.min(nowSec, endSec + RunEnd.COOLDOWN_KEEP_S);
            endMs = startedAt + cut * 1000L;
            snap = state(0);
            try {
                JSONArray tailSteps = new JSONArray(), tailTrack = new JSONArray();
                JSONArray ss = new JSONArray(), tr = new JSONArray(), sm2 = new JSONArray();
                int steps2 = 0;
                for (int[] p : stepSeries) { if (p[0] <= cut) { ss.put(new JSONArray().put(p[0]).put(p[1])); steps2 = p[1]; } else tailSteps.put(new JSONArray().put(p[0]).put(p[1])); }
                for (double[] p : track) { JSONArray a = new JSONArray(); for (double x : p) a.put(x); if (p[0] <= cut) tr.put(a); else tailTrack.put(a); }
                for (int[] p : samples) if (p[0] <= cut) sm2.put(new JSONArray().put(p[0]).put(p[1]));
                snap.put("stepSeries", ss); snap.put("track", tr); snap.put("samples", sm2); snap.put("steps", steps2);
                snap.put("workoutId", workoutId); snap.put("startedAt", startedAt); snap.put("type", type); snap.put("stride", stride);
                snap.put("deviceName", deviceName);
                snap.put("autoEnd", new JSONObject().put("reason", why).put("endedAt", endMs).put("lastRunSec", endSec).put("detectedAt", now));
                if (tailSteps.length() > 0 || tailTrack.length() > 0) snap.put("tail", new JSONObject().put("step_series", tailSteps).put("track", tailTrack));
            } catch (Exception e) { Log.w(TAG, "autoEnd snapshot", e); }
            appendAutoEnded(this, snap);
            try { sessWorkouts.put(new JSONObject().put("id", workoutId).put("startedAt", startedAt).put("endedAt", endMs)); } catch (Exception ignored) {}
            stopAcc(true);
            workoutActive = false; workoutEnd = endMs; phase = "post";
            lastHrAt = Math.max(lastHrAt, now - 30000);
            end = deviceId == null;
        }
        forgotNotified = false;
        try { getSystemService(NotificationManager.class).cancel(ALERT_ID); } catch (Exception ignored) {}
        if (sm != null && end) { sm.unregisterListener(this); stepsOn = false; }
        if (lm != null) { try { lm.removeUpdates(locListener); } catch (Exception ignored) {} }
        if (end) endSession("auto-end"); else { startInForeground(); saveState(); }
        try { if (sessionListener != null) sessionListener.run(); } catch (Exception ignored) {}
    }
    static synchronized void appendAutoEnded(Context ctx, JSONObject o) {
        JSONArray all = readAutoEnded(ctx); all.put(o);
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), AUTOEND_FILE))) { out.write(all.toString().getBytes(StandardCharsets.UTF_8)); }
        catch (Exception e) { Log.w(TAG, "appendAutoEnded", e); }
    }
    static synchronized JSONArray readAutoEnded(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), AUTOEND_FILE);
            if (!f.exists()) return new JSONArray();
            byte[] b = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) { int r = in.read(b); }
            return new JSONArray(new String(b, StandardCharsets.UTF_8));
        } catch (Exception e) { return new JSONArray(); }
    }
    /** handed to the app once; the file is removed only after the app has them (see takeAutoEnded in the plugin) */
    static synchronized JSONArray takeAutoEnded(Context ctx) {
        JSONArray a = readAutoEnded(ctx);
        new File(ctx.getFilesDir(), AUTOEND_FILE).delete();
        return a;
    }

    // ---------------- steps ----------------
    boolean stepsOn = false;
    private void startSteps() {
        if (sm == null || stepsOn) return;
        Sensor s = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        if (s == null) return;
        if (Build.VERSION.SDK_INT >= 29 && !granted(Manifest.permission.ACTIVITY_RECOGNITION)) return;
        stepsOn = sm.registerListener(this, s, SensorManager.SENSOR_DELAY_NORMAL, 0);
    }

    @Override
    public synchronized void onSensorChanged(SensorEvent e) {
        float v = e.values[0];
        stepTotal = (long) v;
        if (!workoutActive) return;   // before / after the run: only remember the counter for anchoring
        if (stepBase < 0 || v < stepBase) { stepBase = v; stepsBefore = steps; }   // first event, after resume, or reboot
        steps = stepsBefore + Math.round(v - stepBase);
        stepTotal = (long) v;
        // event.timestamp is elapsedRealtimeNanos of the step (correct even for batched delivery)
        long wall = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - e.timestamp) / 1_000_000L;
        int sec = (int) Math.max(0, Math.round((wall - startedAt) / 1000.0));
        int n = stepSeries.size();
        if (n > 0 && stepSeries.get(n - 1)[0] >= sec) stepSeries.get(n - 1)[1] = Math.max(stepSeries.get(n - 1)[1], steps);
        else stepSeries.add(new int[] { sec, steps });
    }
    @Override public void onAccuracyChanged(Sensor s, int a) {}

    // ---------------- GPS ----------------
    @SuppressLint("MissingPermission")
    private void startGps() {
        if (!useGps) { gpsStatus = "off"; return; }
        if (!locationGranted()) { gpsStatus = "no-permission"; return; }
        lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) { gpsStatus = "off"; return; }
        try {
            if (!lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) gpsStatus = "disabled"; else gpsStatus = "searching";
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, locListener, Looper.getMainLooper());
        } catch (Exception ex) { Log.w(TAG, "gps failed", ex); gpsStatus = "off"; }
    }

    private final LocationListener locListener = new LocationListener() {
        @Override public void onLocationChanged(Location l) { onLocation(l); }
        @Override public void onProviderEnabled(String p) { gpsStatus = "searching"; }
        @Override public void onProviderDisabled(String p) { gpsStatus = "disabled"; }
        @Override public void onStatusChanged(String p, int s, android.os.Bundle b) {}
    };

    private synchronized void onLocation(Location l) {
        long now = l.getTime() > 0 ? l.getTime() : System.currentTimeMillis();
        if (now < startedAt - 2000) return;
        double acc = l.hasAccuracy() ? l.getAccuracy() : 99;
        int sec = (int) Math.max(0, Math.round((now - startedAt) / 1000.0));
        double lat = Math.round(l.getLatitude() * 1e6) / 1e6, lon = Math.round(l.getLongitude() * 1e6) / 1e6;
        int n = track.size();
        if (n > 0 && track.get(n - 1)[0] >= sec) return;
        track.add(new double[] { sec, lat, lon, Math.round(acc * 10) / 10.0 });
        gpsAcc = acc; gpsAt = System.currentTimeMillis();
        gpsSpeed = l.hasSpeed() ? l.getSpeed() : 0;
        gpsStatus = acc <= 25 ? "ok" : "searching";
        if (acc > 25) return;
        // smooth jitter: mean of the last 3 good fixes (same idea as analysis.js)
        recent.add(new double[] { sec, lat, lon });
        while (recent.size() > 3 || (recent.size() > 1 && sec - recent.get(0)[0] > 3)) recent.remove(0);
        double sl = 0, so = 0; for (double[] r : recent) { sl += r[1]; so += r[2]; }
        lat = sl / recent.size(); lon = so / recent.size();
        if (gpsAnchor == null) { gpsAnchor = new double[] { sec, lat, lon, acc }; return; }
        float[] d = new float[1];
        Location.distanceBetween(gpsAnchor[1], gpsAnchor[2], lat, lon, d);
        double dt = Math.max(1, sec - gpsAnchor[0]);
        if (d[0] / dt > 12) return;                                  // jump
        if (d[0] >= Math.max(4, 0.6 * Math.max(acc, gpsAnchor[3]))) {  // ignore jitter while standing
            gpsDist += d[0];
            gpsAnchor = new double[] { sec, lat, lon, acc };
        }
    }

    // ---------------- heart rate (BLE GATT) ----------------
    synchronized void setDevice(String id, String name) {
        deviceId = id; deviceName = name;
        handler.post(() -> { closeGatt(); connectHr(); });
    }

    @SuppressLint("MissingPermission")
    private void connectHr() {
        if (!running || deviceId == null) return;
        if (Build.VERSION.SDK_INT >= 31 && !granted(Manifest.permission.BLUETOOTH_CONNECT)) { hrStatus = "error:нет разрешения Bluetooth"; return; }
        try {
            BluetoothManager bm = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter ad = bm != null ? bm.getAdapter() : null;
            if (ad == null || !ad.isEnabled()) { hrStatus = "error:Bluetooth выключен"; scheduleReconnect(); return; }
            BluetoothDevice dev = ad.getRemoteDevice(deviceId);
            hrStatus = "connecting";
            gatt = dev.connectGatt(this, false, gattCb, BluetoothDevice.TRANSPORT_LE);
        } catch (Exception ex) {
            Log.w(TAG, "connect failed", ex);
            hrStatus = "error:" + ex.getMessage();
            scheduleReconnect();
        }
    }

    private void scheduleReconnect() {
        if (!running || deviceId == null) return;
        handler.postDelayed(() -> { if (running && !"connected".equals(hrStatus)) { closeGatt(); connectHr(); } }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    }

    @SuppressLint("MissingPermission")
    private void closeGatt() {
        if (gatt != null) { try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) {} gatt = null; }
    }

    // ---- GATT operation queue (Android allows one outstanding GATT operation) ----
    private final java.util.ArrayDeque<Runnable> gattOps = new java.util.ArrayDeque<>();
    private boolean gattBusy = false;
    private void gattEnqueue(Runnable r) { handler.post(() -> { gattOps.add(r); gattNext(); }); }
    private void gattNext() {
        if (gattBusy || gattOps.isEmpty()) return;
        gattBusy = true;
        Runnable r = gattOps.poll();
        try { r.run(); } catch (Exception e) { Log.w(TAG, "gatt op", e); gattBusy = false; gattNext(); }
        handler.postDelayed(gattWatchdog, 3000);
    }
    private final Runnable gattWatchdog = () -> { if (gattBusy) { gattBusy = false; gattNext(); } };
    private void gattDone() { handler.post(() -> { handler.removeCallbacks(gattWatchdog); gattBusy = false; gattNext(); }); }

    @SuppressLint("MissingPermission")
    private void writeCccd(BluetoothGattCharacteristic c, byte[] value) {
        BluetoothGatt g = gatt;
        if (g == null || c == null) { gattDone(); return; }
        g.setCharacteristicNotification(c, true);
        BluetoothGattDescriptor d = c.getDescriptor(CCCD);
        if (d == null) { gattDone(); return; }
        boolean ok;
        if (Build.VERSION.SDK_INT >= 33) ok = g.writeDescriptor(d, value) == 0;
        else { d.setValue(value); ok = g.writeDescriptor(d); }
        if (!ok) gattDone();
    }

    @SuppressLint("MissingPermission")
    @SuppressWarnings("deprecation")
    private void writeChar(BluetoothGattCharacteristic c, byte[] value) {
        BluetoothGatt g = gatt;
        if (g == null || c == null) { gattDone(); return; }
        boolean ok;
        if (Build.VERSION.SDK_INT >= 33) ok = g.writeCharacteristic(c, value, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == 0;
        else { c.setValue(value); c.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT); ok = g.writeCharacteristic(c); }
        if (!ok) gattDone();
    }

    // ---- Polar PMD (H10 raw ECG) ----
    static final UUID PMD_SVC = UUID.fromString("fb005c80-02e7-f387-1cad-8acd2d8df0c8");
    static final UUID PMD_CP = UUID.fromString("fb005c81-02e7-f387-1cad-8acd2d8df0c8");
    static final UUID PMD_DATA = UUID.fromString("fb005c82-02e7-f387-1cad-8acd2d8df0c8");
    static final String ECG_DIR = "ecg-pending";
    private BluetoothGattCharacteristic pmdCp, pmdData;
    boolean ecgCapable = false;
    String ecgStatus = "idle";   // idle | starting | recording | error:<msg>
    int ecgTarget = 0; long ecgStartedAt = 0, ecgRequestedAt = 0;
    private int[] ecgBuf = new int[0]; int ecgCount = 0; int ecgMtu = 23; boolean ecgCpReady = false;
    String lastEcgId = null;
    boolean ecgRetried = false;
    long ecgFrames = 0;
    // start ECG: type 0, setting 0 (sample rate) ×1 = 130, setting 1 (resolution) ×1 = 14 bit
    static final byte[] ECG_START = { 0x02, 0x00, 0x00, 0x01, (byte) 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00 };
    static String hex(byte[] v) { if (v == null) return "null"; StringBuilder b = new StringBuilder(); for (int i = 0; i < Math.min(v.length, 24); i++) b.append(String.format("%02x ", v[i] & 0xff)); if (v.length > 24) b.append("… (" + v.length + ")"); return b.toString(); }
    int[] ecgBufRef() { return ecgBuf; }

    synchronized String startEcg(int seconds) {
        if (gatt == null || !"connected".equals(hrStatus)) return "пояс не подключён";
        if (!ecgCapable || pmdCp == null || pmdData == null) return "этот пояс не отдаёт ЭКГ (нужен Polar H10)";
        if ("recording".equals(ecgStatus) || "starting".equals(ecgStatus)) return "ЭКГ уже записывается";
        ecgTarget = Math.max(10, Math.min(600, seconds)) * 130; ecgFrames = 0;
        Log.i(TAG, "PMD startEcg " + seconds + "s, cpReady=" + ecgCpReady + " mtu=" + ecgMtu);
        ecgBuf = new int[ecgTarget + 400]; ecgCount = 0; ecgStartedAt = 0; ecgRequestedAt = System.currentTimeMillis();
        ecgStatus = "starting";
        final BluetoothGattCharacteristic cp = pmdCp, dt = pmdData;
        if (!ecgCpReady) {
            gattEnqueue(() -> writeCccd(cp, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE));
            gattEnqueue(() -> writeCccd(dt, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE));
            ecgCpReady = true;
        }
        ecgRetried = false;
        // a stream left running (earlier attempt / app restart) answers "already in state" → stop it first (its error is ignored)
        gattEnqueue(() -> writeChar(cp, new byte[] { 0x03, 0x00 }));
        gattEnqueue(() -> writeChar(cp, ECG_START));
        handler.postDelayed(ecgStartWatch, 3500);
        return null;
    }
    private final Runnable ecgStartWatch = () -> {
        synchronized (WorkoutService.this) {
            Log.i(TAG, "PMD watchdog: status=" + ecgStatus + " count=" + ecgCount + " frames=" + ecgFrames + " mtu=" + ecgMtu);
            if ("starting".equals(ecgStatus) && ecgCount == 0 && !ecgRetried && pmdCp != null) {
                ecgRetried = true; final BluetoothGattCharacteristic cp = pmdCp, dt = pmdData;
                gattEnqueue(() -> writeChar(cp, new byte[] { 0x03, 0x00 }));
                gattEnqueue(() -> writeCccd(dt, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE));
                gattEnqueue(() -> writeChar(cp, ECG_START));
                handler.postDelayed(WorkoutService.this.ecgStartWatch2, 8000);
                return;
            }
            if ("starting".equals(ecgStatus) && ecgCount == 0) { ecgStatus = "error:пояс не начал передачу ЭКГ (закрой другие приложения Polar и попробуй ещё раз)"; } }
    };

    private final Runnable ecgStartWatch2 = () -> {
        synchronized (WorkoutService.this) { if ("starting".equals(ecgStatus) && ecgCount == 0) { ecgStatus = "error:пояс не начал передачу ЭКГ (кадров " + ecgFrames + ", MTU " + ecgMtu + "). Отключи и снова подключи пояс и попробуй ещё раз"; } }
    };

    synchronized void stopEcg(boolean save) {
        final BluetoothGattCharacteristic cp = pmdCp;
        if (cp != null && ("recording".equals(ecgStatus) || "starting".equals(ecgStatus))) gattEnqueue(() -> writeChar(cp, new byte[] { 0x03, 0x00 }));
        if (save && ecgCount >= 130 * 5) saveEcg();
        if (!ecgStatus.startsWith("error:")) ecgStatus = "idle";
        handler.removeCallbacks(ecgStartWatch); handler.removeCallbacks(ecgStartWatch2);
    }

    private void saveEcg() {
        try {
            int n = ecgCount;
            byte[] b = new byte[n * 2];
            for (int i = 0; i < n; i++) { int v = Math.max(-32768, Math.min(32767, ecgBuf[i])); b[2 * i] = (byte) (v & 0xff); b[2 * i + 1] = (byte) ((v >> 8) & 0xff); }
            JSONObject o = new JSONObject();
            String id = "e" + Long.toString(ecgStartedAt, 36);
            o.put("id", id); o.put("started_at", ecgStartedAt); o.put("fs", 130); o.put("n", n);
            o.put("duration_s", Math.round(n / 1.3) / 100.0); o.put("device", deviceName);
            o.put("samples_b64", android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP));
            o.put("session_start", sessionStart); o.put("phase", phase); o.put("workout_id", workoutActive ? workoutId : (sessWorkouts.length() > 0 ? sessWorkouts.optJSONObject(sessWorkouts.length() - 1).optString("id", null) : null));
            File dir = new File(getFilesDir(), ECG_DIR); dir.mkdirs();
            try (FileOutputStream out = new FileOutputStream(new File(dir, id + ".json"))) { out.write(o.toString().getBytes(StandardCharsets.UTF_8)); }
            lastEcgId = id;
        } catch (Exception e) { Log.w(TAG, "saveEcg", e); }
    }

    static JSONArray takeEcg(Context ctx) {
        JSONArray a = new JSONArray();
        File dir = new File(ctx.getFilesDir(), ECG_DIR);
        File[] fs = dir.listFiles();
        if (fs == null) return a;
        for (File f : fs) {
            try {
                byte[] b = new byte[(int) f.length()];
                try (FileInputStream in = new FileInputStream(f)) { int r = in.read(b); }
                a.put(new JSONObject(new String(b, StandardCharsets.UTF_8)));
                f.delete();
            } catch (Exception ignored) {}
        }
        return a;
    }

    private void onPmdData(byte[] v) {
        if (v != null && v.length > 0 && v[0] == 0x02) { onAccData(v); return; }
        ecgFrames++;
        if (ecgFrames <= 3 || ecgFrames % 200 == 0) Log.i(TAG, "PMD data #" + ecgFrames + ": " + hex(v));
        if (v == null || v.length < 10 || v[0] != 0x00) return;   // 0x00 = ECG
        int frameType = v[9] & 0xff;
        if (frameType != 0x00) return;                         // uncompressed 3-byte µV samples
        synchronized (this) {
            if (!("recording".equals(ecgStatus) || "starting".equals(ecgStatus))) return;
            int nNew = (v.length - 10) / 3;
            if (ecgCount == 0) { ecgStartedAt = System.currentTimeMillis() - Math.round(nNew * 1000.0 / 130); ecgStatus = "recording"; }
            for (int i = 0; i < nNew && ecgCount < ecgBuf.length; i++) {
                int o = 10 + 3 * i;
                int x = (v[o] & 0xff) | ((v[o + 1] & 0xff) << 8) | ((v[o + 2] & 0xff) << 16);
                if ((x & 0x800000) != 0) x |= 0xff000000;   // sign-extend 24-bit
                ecgBuf[ecgCount++] = x;
            }
            if (ecgCount >= ecgTarget) handler.post(() -> stopEcg(true));
        }
    }

    private void onAccData(byte[] v) {
        boolean stopTest = false;
        synchronized (this) {
            accFramesSeen++;
            if (accFramesSeen <= 2 || accFramesSeen % 1000 == 0) Log.i(TAG, "ACC data #" + accFramesSeen + ": " + hex(v));
            if (acc == null) return;
            int n = acc.onFrame(v, System.currentTimeMillis());
            if (n > 0 && "starting".equals(accStatus)) {
                accStatus = "recording"; handler.removeCallbacks(accWatch);
                Log.i(TAG, "ACC first data " + (System.currentTimeMillis() - accRequestedAt) + " ms after start (retries " + accRetries + ")");
            }
            if (accTest && accTestUntil > 0 && System.currentTimeMillis() >= accTestUntil) stopTest = true;
        }
        if (stopTest) handler.post(() -> stopAcc(true));
    }

    private void onPmdCp(byte[] v) {
        // response: F0 <op> <type> <status> ...
        Log.i(TAG, "PMD cp: " + hex(v));
        if (v == null || v.length < 4 || (v[0] & 0xff) != 0xF0) return;
        int op = v[1] & 0xff, status = v[3] & 0xff;
        if ((v[2] & 0xff) == 0x02) {   // ACC
            if (op == 0x02 && status != 0 && status != 6) synchronized (this) { accStatus = "error:пояс отказал в акселерометре (код " + status + ")"; Log.w(TAG, accStatus); }
            return;
        }
        if (op == 0x02 && status == 6) {
            // "already in state": the strap is streaming ECG already → just wait for the data (watchdog restarts it otherwise)
            Log.i(TAG, "PMD start: already streaming, waiting for data");
            return;
        }
        if (op == 0x02 && status != 0) {
            synchronized (this) {
                String[] names = { "ok", "неверная команда", "неверный тип измерения", "не поддерживается", "неверная длина", "неверный параметр",
                    "уже в этом состоянии", "неверное разрешение", "неверная частота", "неверный диапазон", "мало MTU", "неверное число каналов", "неверное состояние", "на зарядке" };
                String why = status < names.length ? names[status] : ("код " + status);
                ecgStatus = "error:пояс отказал в ЭКГ: " + why + " (" + status + ")";
            }
        }
    }

    // ---- Polar H10 accelerometer (raw, run only) ----
    AccRecorder acc = null;
    String accStatus = "idle";   // idle | starting | recording | error:<msg>
    long accTestUntil = 0; long accFramesSeen = 0;
    boolean accTest = false;

    /** Start raw ACC streaming into acc/<id>. test=true: a short check outside a workout (seconds). */
    synchronized String startAcc(boolean test, int seconds) {
        if (!test && !workoutActive) return "нет тренировки";
        if (!test && deviceId == null) return startPhoneAcc();
        if (acc != null && ("recording".equals(accStatus) || "starting".equals(accStatus)) ) return null;
        if (gatt == null || !"connected".equals(hrStatus) || pmdCp == null || pmdData == null) {
            accStatus = "idle";
            Log.i(TAG, "ACC start skipped: gatt=" + (gatt != null) + " hr=" + hrStatus + " pmd=" + (pmdCp != null) + " (will start on (re)connect)");
            return "пояс не подключён или без PMD";
        }
        try {
            String id = test ? ("t" + Long.toString(System.currentTimeMillis(), 36)) : ("a" + (workoutId != null ? workoutId : Long.toString(startedAt, 36)));
            if (acc == null || !acc.id.equals(id)) acc = new AccRecorder(getFilesDir(), id, test ? System.currentTimeMillis() : startedAt, deviceName, test ? null : workoutId, test);
        } catch (Exception e) { accStatus = "error:" + e.getMessage(); return accStatus; }
        accTest = test; accTestUntil = test ? System.currentTimeMillis() + Math.max(5, Math.min(300, seconds)) * 1000L : 0;
        accStatus = "starting"; accRetries = 0; accRequestedAt = System.currentTimeMillis();
        final BluetoothGattCharacteristic cp = pmdCp, dt = pmdData;
        Log.i(TAG, "ACC start " + acc.id + (test ? " test " + seconds + "s" : "") + " cpReady=" + ecgCpReady + " queue=" + gattOps.size() + " busy=" + gattBusy);
        if (!ecgCpReady) {
            gattEnqueue(() -> { Log.i(TAG, "ACC step: CCCD cp"); writeCccd(cp, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE); });
            gattEnqueue(() -> { Log.i(TAG, "ACC step: CCCD data"); writeCccd(dt, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE); });
            ecgCpReady = true;
        }
        gattEnqueue(() -> { Log.i(TAG, "ACC step: STOP"); writeChar(cp, AccRecorder.STOP); });
        gattEnqueue(() -> { Log.i(TAG, "ACC step: START"); writeChar(cp, AccRecorder.START); });
        handler.removeCallbacks(accWatch); handler.postDelayed(accWatch, ACC_RETRY_MS);
        return null;
    }
    // ---- beltless run: the phone's own accelerometer (50 Hz, raw magnitude profile for run start / pauses; no chest-style dynamics) ----
    static final int PHONE_ACC_US = 20000;
    private SensorEventListener phoneAccL = null;
    synchronized String startPhoneAcc() {
        if (phoneAccL != null) return null;
        if (!"run".equals(type) && !"walk".equals(type)) return null;
        if (sm == null) return "нет датчика";
        Sensor s = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (s == null) { accStatus = "error:в телефоне нет акселерометра"; return accStatus; }
        try {
            String id = "a" + (workoutId != null ? workoutId : Long.toString(startedAt, 36));
            if (acc == null || !acc.id.equals(id)) {
                acc = new AccRecorder(getFilesDir(), id, startedAt, "phone", workoutId, false);
                acc.source = "phone"; acc.fsNom = 50; acc.writeMeta("phone", workoutId, false, false);
            }
        } catch (Exception e) { accStatus = "error:" + e.getMessage(); return accStatus; }
        final AccRecorder rec = acc;
        phoneAccL = new SensorEventListener() {
            @Override public void onSensorChanged(SensorEvent e) {
                long wall = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - e.timestamp) / 1_000_000L;
                rec.onPhoneSample(e.timestamp, e.values[0], e.values[1], e.values[2], wall);
            }
            @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        boolean ok = sm.registerListener(phoneAccL, s, PHONE_ACC_US, 1_000_000);
        accStatus = ok ? "recording" : "error:не удалось включить акселерометр телефона";
        Log.i(TAG, "phone ACC " + (ok ? "on" : "FAILED") + " " + rec.id);
        return ok ? null : accStatus;
    }
    private void stopPhoneAcc() {
        if (phoneAccL != null && sm != null) { try { sm.unregisterListener(phoneAccL); } catch (Exception ignored) {} }
        phoneAccL = null;
    }
    static final long ACC_RETRY_MS = 2000; static final int ACC_MAX_RETRIES = 5;
    int accRetries = 0; long accRequestedAt = 0;
    /** No data 2 s after START → stop + re-enable notifications + start again (up to 5 times, every 2 s). */
    private final Runnable accWatch = new Runnable() { @Override public void run() {
        synchronized (WorkoutService.this) {
            if (!"starting".equals(accStatus) || pmdCp == null) return;
            if (accRetries >= ACC_MAX_RETRIES) { Log.w(TAG, "ACC watchdog: no data after " + accRetries + " retries"); accStatus = "error:пояс не начал передачу акселерометра"; return; }
            accRetries++;
            Log.i(TAG, "ACC watchdog: no data " + (System.currentTimeMillis() - accRequestedAt) + " ms after start, retry " + accRetries + " (queue=" + gattOps.size() + " busy=" + gattBusy + ")");
            final BluetoothGattCharacteristic cp = pmdCp, dt = pmdData;
            gattEnqueue(() -> writeChar(cp, AccRecorder.STOP));
            gattEnqueue(() -> writeCccd(dt, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE));
            gattEnqueue(() -> writeChar(cp, AccRecorder.START));
            handler.postDelayed(this, ACC_RETRY_MS);
        }
    } };
    /** complete=true: the run is over, the file is final and may be uploaded. */
    synchronized void stopAcc(boolean complete) {
        handler.removeCallbacks(accWatch);
        if (complete) stopPhoneAcc();
        final BluetoothGattCharacteristic cp = pmdCp;
        if (cp != null && gatt != null && ("recording".equals(accStatus) || "starting".equals(accStatus))) gattEnqueue(() -> writeChar(cp, AccRecorder.STOP));
        if (acc != null) { if (complete) acc.close(true); else acc.flush(); if (complete) acc = null; }
        if (!accStatus.startsWith("error:") || complete) accStatus = "idle";
        accTest = false; accTestUntil = 0;
    }
    synchronized void pauseAccOnDisconnect() {
        handler.removeCallbacks(accWatch);
        if (acc != null) acc.flush();
        if ("recording".equals(accStatus) || "starting".equals(accStatus)) accStatus = "idle";
    }

    // ---- Battery (0x180F / 0x2A19): the H10 reports only %, logged with time to judge battery health ----
    static final UUID BAS = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb");
    static final UUID BATT_LEVEL = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb");
    static final String BATT_LOG = "strap-battery.jsonl";
    private BluetoothGattCharacteristic battChar;
    int battLevel = -1; long battAt = 0;
    @SuppressLint("MissingPermission")
    void readBattery() {
        final BluetoothGattCharacteristic b = battChar;
        if (b == null || gatt == null) return;
        gattEnqueue(() -> { BluetoothGatt g = gatt; if (g == null || !g.readCharacteristic(b)) gattDone(); });
    }
    private void onBattery(byte[] v) {
        if (v == null || v.length < 1) return;
        int lvl = v[0] & 0xff; if (lvl > 100) return;
        long now = System.currentTimeMillis();
        synchronized (this) { battLevel = lvl; battAt = now; }
        try (FileOutputStream out = new FileOutputStream(new File(getFilesDir(), BATT_LOG), true)) {
            JSONObject o = new JSONObject().put("t", now).put("level", lvl).put("device", deviceName).put("device_id", deviceId).put("phase", phase)
                .put("acc", "recording".equals(accStatus));
            out.write((o.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
        Log.i(TAG, "strap battery " + lvl + "%");
    }
    static JSONArray takeBattery(Context ctx) {
        JSONArray a = new JSONArray();
        File f = new File(ctx.getFilesDir(), BATT_LOG);
        if (!f.exists()) return a;
        try {
            byte[] b = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) { int r = in.read(b); }
            for (String line : new String(b, StandardCharsets.UTF_8).split("\n")) { line = line.trim(); if (!line.isEmpty()) try { a.put(new JSONObject(line)); } catch (Exception ignored) {} }
            f.delete();
        } catch (Exception ignored) {}
        return a;
    }

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
            if (state == BluetoothProfile.STATE_CONNECTED) {
                hrStatus = "connecting";
                g.discoverServices();
            } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                hrStatus = "disconnected";
                synchronized (WorkoutService.this) {
                    if ("recording".equals(ecgStatus) || "starting".equals(ecgStatus)) { if (ecgCount >= 130 * 5) saveEcg(); ecgStatus = "error:связь с поясом прервалась во время ЭКГ"; }
                    ecgCpReady = false;
                }
                pauseAccOnDisconnect();
                handler.post(() -> { gattOps.clear(); gattBusy = false; closeGatt(); scheduleReconnect(); });
            }
        }

        @SuppressLint("MissingPermission")
        @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
            BluetoothGattService s = g.getService(HRS);
            final BluetoothGattCharacteristic c = s != null ? s.getCharacteristic(HRM) : null;
            if (c == null) { hrStatus = "error:нет сервиса пульса"; return; }
            BluetoothGattService pmd = g.getService(PMD_SVC);
            pmdCp = pmd != null ? pmd.getCharacteristic(PMD_CP) : null;
            pmdData = pmd != null ? pmd.getCharacteristic(PMD_DATA) : null;
            ecgCapable = pmdCp != null && pmdData != null;
            ecgCpReady = false;
            BluetoothGattService bas = g.getService(BAS);
            battChar = bas != null ? bas.getCharacteristic(BATT_LEVEL) : null;
            if (ecgCapable) gattEnqueue(() -> { BluetoothGatt gg = gatt; if (gg == null || !gg.requestMtu(232)) gattDone(); });
            gattEnqueue(() -> writeCccd(c, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE));
            hrStatus = "connected";
            readBattery();
            if (workoutActive && ecgCapable) handler.postDelayed(() -> startAcc(false, 0), 1500);   // reconnect mid-run: append to the same file
            reconnectDelay = 2000;
        }

        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) { ecgMtu = mtu; Log.i(TAG, "MTU " + mtu + " status " + status); gattDone(); }
        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) { Log.i(TAG, "CCCD " + d.getCharacteristic().getUuid().toString().substring(4, 8) + " status " + status); gattDone(); }
        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int status) {
            if (BATT_LEVEL.equals(c.getUuid()) && status == 0) onBattery(value);
            gattDone();
        }
        @SuppressWarnings("deprecation")
        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            if (Build.VERSION.SDK_INT >= 33) return;
            if (BATT_LEVEL.equals(c.getUuid()) && status == 0) onBattery(c.getValue());
            gattDone();
        }
        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) { Log.i(TAG, "write " + c.getUuid().toString().substring(4, 8) + " status " + status); gattDone(); }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            dispatch(c, value);
        }

        @SuppressWarnings("deprecation")
        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            if (Build.VERSION.SDK_INT < 33) dispatch(c, c.getValue());
        }
    };

    private void dispatch(BluetoothGattCharacteristic c, byte[] value) {
        UUID u = c.getUuid();
        if (HRM.equals(u)) onHr(value);
        else if (PMD_DATA.equals(u)) onPmdData(value);
        else if (PMD_CP.equals(u)) onPmdCp(value);
    }

    // RR intervals: [ms since session start (beat time), rr ms]
    final ArrayList<int[]> rr = new ArrayList<>();
    long noContactSince = 0;

    private void onHr(byte[] v) {
        if (v == null || v.length < 2) return;
        int flags = v[0] & 0xff;
        boolean u16 = (flags & 1) != 0;
        int value = (u16 && v.length >= 3) ? ((v[1] & 0xff) | ((v[2] & 0xff) << 8)) : (v[1] & 0xff);
        int off = u16 ? 3 : 2;
        if ((flags & 0x08) != 0) off += 2;   // energy expended present
        ArrayList<Integer> rrs = new ArrayList<>();
        if ((flags & 0x10) != 0) for (int i = off; i + 1 < v.length; i += 2) rrs.add((int) Math.round(((v[i] & 0xff) | ((v[i + 1] & 0xff) << 8)) * 1000.0 / 1024.0));
        if (!validBeat(flags, value)) { synchronized (this) { hrStatus = "connected"; if (value == 0 || (flags & 0x06) == 0x04) noContactSince = noContactSince == 0 ? System.currentTimeMillis() : noContactSince; } return; }
        synchronized (this) {
            long now = System.currentTimeMillis();
            noContactSince = 0;
            bpm = value; bpmAt = now; lastHrAt = now; hrStatus = "connected";
            // beat times: last RR ends now, earlier ones before it
            long nowRel = now - sessionStart;
            long[] ts = beatTimes(rrs, nowRel, rr.isEmpty() ? Long.MIN_VALUE : rr.get(rr.size() - 1)[0]);
            for (int i = 0; i < rrs.size(); i++) rr.add(new int[] { (int) ts[i], rrs.get(i) });
            int ss = (int) Math.round((now - sessionStart) / 1000.0);
            int m = sess.size();
            if (m > 0 && sess.get(m - 1)[0] == ss) sess.get(m - 1)[1] = value;
            else sess.add(new int[] { ss, value });
            if (!workoutActive) return;
            int sec = (int) Math.round((now - startedAt) / 1000.0);
            int n = samples.size();
            if (n > 0 && samples.get(n - 1)[0] == sec) samples.get(n - 1)[1] = value;
            else samples.add(new int[] { sec, value });
        }
    }

    // ---------------- state for JS ----------------
    synchronized JSONObject state(int since) { return state(since, 0, 0, 0, 0); }

    synchronized JSONObject state(int since, int sinceSteps, int sinceTrack, int sinceSess) { return state(since, sinceSteps, sinceTrack, sinceSess, 0); }

    synchronized JSONObject state(int since, int sinceSteps, int sinceTrack, int sinceSess, int sinceRr) {
        JSONObject o = new JSONObject();
        try {
            o.put("running", running);
            o.put("startedAt", startedAt);
            o.put("type", type);
            o.put("stride", stride);
            o.put("deviceId", deviceId);
            o.put("deviceName", deviceName);
            o.put("steps", steps);
            o.put("bpm", bpm);
            o.put("bpmAt", bpmAt);
            o.put("hrStatus", hrStatus);
            o.put("sampleCount", samples.size());
            JSONArray arr = new JSONArray();
            for (int i = Math.max(0, since); i < samples.size(); i++) arr.put(new JSONArray().put(samples.get(i)[0]).put(samples.get(i)[1]));
            o.put("samples", arr);
            o.put("since", Math.max(0, since));
            JSONArray ss = new JSONArray();
            for (int i = Math.max(0, sinceSteps); i < stepSeries.size(); i++) ss.put(new JSONArray().put(stepSeries.get(i)[0]).put(stepSeries.get(i)[1]));
            o.put("stepSeries", ss);
            o.put("sinceSteps", Math.max(0, sinceSteps));
            o.put("stepSeriesCount", stepSeries.size());
            JSONArray tr = new JSONArray();
            for (int i = Math.max(0, sinceTrack); i < track.size(); i++) { double[] p = track.get(i); tr.put(new JSONArray().put((int) p[0]).put(p[1]).put(p[2]).put(p[3])); }
            o.put("track", tr);
            o.put("sinceTrack", Math.max(0, sinceTrack));
            o.put("trackCount", track.size());
            o.put("gps", useGps);
            o.put("gpsStatus", gpsStatus);
            o.put("gpsDist", Math.round(gpsDist * 10) / 10.0);
            o.put("gpsAcc", gpsAcc);
            o.put("gpsSpeed", gpsSpeed);
            o.put("gpsAt", gpsAt);
            o.put("phase", phase);
            o.put("workoutActive", workoutActive);
            o.put("workoutId", workoutId);
            o.put("workoutEnd", workoutEnd);
            o.put("sessionStart", sessionStart);
            o.put("lastHrAt", lastHrAt);
            o.put("contact", noContactSince == 0);
            o.put("postMin", postMin);
            o.put("sessWorkouts", new JSONArray(sessWorkouts.toString()));
            JSONArray se = new JSONArray();
            for (int i = Math.max(0, sinceSess); i < sess.size(); i++) se.put(new JSONArray().put(sess.get(i)[0]).put(sess.get(i)[1]));
            o.put("sess", se);
            o.put("sinceSess", Math.max(0, sinceSess));
            o.put("sessCount", sess.size());
            JSONArray ra = new JSONArray();
            for (int i = Math.max(0, sinceRr); i < rr.size(); i++) ra.put(new JSONArray().put(rr.get(i)[0]).put(rr.get(i)[1]));
            o.put("rr", ra);
            o.put("sinceRr", Math.max(0, sinceRr));
            o.put("rrCount", rr.size());
            o.put("ecgCapable", ecgCapable);
            o.put("accStatus", accStatus);
            o.put("accSamples", acc != null ? acc.samples : 0);
            o.put("accSteps", acc != null ? acc.steps : 0);
            o.put("accId", acc != null ? acc.id : null);
            o.put("strapBattery", battLevel);
            o.put("strapBatteryAt", battAt);
            o.put("ecgStatus", ecgStatus);
            o.put("ecgCount", ecgCount);
            o.put("ecgTarget", ecgTarget);
            o.put("ecgStartedAt", ecgStartedAt);
            o.put("lastEcgId", lastEcgId);
        } catch (Exception ignored) {}
        return o;
    }

    synchronized void saveState() {
        try {
            JSONObject o = state(0);
            o.put("stepsBefore", steps);
            if (gpsAnchor != null) o.put("gpsAnchor", new JSONArray().put(gpsAnchor[0]).put(gpsAnchor[1]).put(gpsAnchor[2]).put(gpsAnchor[3]));
            File f = new File(getFilesDir(), STATE_FILE);
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(o.toString().getBytes(StandardCharsets.UTF_8)); }
        } catch (Exception e) { Log.w(TAG, "save failed", e); }
    }

    static JSONObject readSavedState(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), STATE_FILE);
            if (!f.exists()) return null;
            byte[] b = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) { int r = in.read(b); }
            return new JSONObject(new String(b, StandardCharsets.UTF_8));
        } catch (Exception e) { return null; }
    }

    static void clearSavedState(Context ctx) { new File(ctx.getFilesDir(), STATE_FILE).delete(); }

    private boolean loadState() {
        JSONObject o = readSavedState(this);
        if (o == null) return false;
        startedAt = o.optLong("startedAt", System.currentTimeMillis());
        type = o.optString("type", "run");
        stride = o.optDouble("stride", 0.75);
        deviceId = o.isNull("deviceId") ? null : o.optString("deviceId", null);
        deviceName = o.isNull("deviceName") ? null : o.optString("deviceName", null);
        steps = o.optInt("steps", 0); stepsBefore = steps; stepBase = -1;
        samples.clear();
        JSONArray arr = o.optJSONArray("samples");
        if (arr != null) for (int i = 0; i < arr.length(); i++) { JSONArray p = arr.optJSONArray(i); if (p != null) samples.add(new int[] { p.optInt(0), p.optInt(1) }); }
        stepSeries.clear();
        JSONArray ss = o.optJSONArray("stepSeries");
        if (ss != null) for (int i = 0; i < ss.length(); i++) { JSONArray p = ss.optJSONArray(i); if (p != null) stepSeries.add(new int[] { p.optInt(0), p.optInt(1) }); }
        track.clear();
        JSONArray tr = o.optJSONArray("track");
        if (tr != null) for (int i = 0; i < tr.length(); i++) { JSONArray p = tr.optJSONArray(i); if (p != null) track.add(new double[] { p.optDouble(0), p.optDouble(1), p.optDouble(2), p.optDouble(3) }); }
        useGps = o.optBoolean("gps", true);
        gpsDist = o.optDouble("gpsDist", 0);
        JSONArray an = o.optJSONArray("gpsAnchor");
        gpsAnchor = an != null ? new double[] { an.optDouble(0), an.optDouble(1), an.optDouble(2), an.optDouble(3) } : null;
        sessionStart = o.optLong("sessionStart", startedAt);
        phase = o.optString("phase", "workout");
        workoutActive = o.optBoolean("workoutActive", true);
        workoutId = o.isNull("workoutId") ? null : o.optString("workoutId", null);
        workoutEnd = o.optLong("workoutEnd", 0);
        lastHrAt = Math.max(o.optLong("lastHrAt", 0), System.currentTimeMillis() - 60000);   // grace after a restart
        postMin = o.optInt("postMin", 90);
        sess.clear();
        JSONArray se = o.optJSONArray("sess");
        if (se != null) for (int i = 0; i < se.length(); i++) { JSONArray p = se.optJSONArray(i); if (p != null) sess.add(new int[] { p.optInt(0), p.optInt(1) }); }
        while (sessWorkouts.length() > 0) sessWorkouts.remove(0);
        rr.clear();
        JSONArray ra = o.optJSONArray("rr");
        if (ra != null) for (int i = 0; i < ra.length(); i++) { JSONArray p = ra.optJSONArray(i); if (p != null) rr.add(new int[] { p.optInt(0), p.optInt(1) }); }
        JSONArray sw = o.optJSONArray("sessWorkouts");
        if (sw != null) for (int i = 0; i < sw.length(); i++) sessWorkouts.put(sw.opt(i));
        return true;
    }

    /** Stop recording and return the final state (with all samples). */
    synchronized JSONObject finish() {
        JSONObject o = state(0);
        running = false;
        try { o.put("running", false); } catch (Exception ignored) {}
        return o;
    }

    /** Stop the workout part; HR monitoring continues for recovery if a strap is in use. */
    JSONObject finishWorkout(boolean keepSession) {
        JSONObject o;
        boolean end;
        synchronized (this) {
            long now = System.currentTimeMillis();
            o = state(0);
            if (workoutActive) {
                try { sessWorkouts.put(new JSONObject().put("id", workoutId).put("startedAt", startedAt).put("endedAt", now)); } catch (Exception ignored) {}
            }
            stopAcc(true);
            workoutActive = false; workoutEnd = now; phase = "post";
            lastHrAt = Math.max(lastHrAt, now - 30000);
            end = !keepSession || deviceId == null;
            try { o.put("workoutEndedAt", now); o.put("sessionContinues", !end); } catch (Exception ignored) {}
        }
        if (sm != null && end) { sm.unregisterListener(this); stepsOn = false; }   // a session that goes on keeps the counter warm
        if (lm != null) { try { lm.removeUpdates(locListener); } catch (Exception ignored) {} }
        if (end) endSession("stop");
        else { startInForeground(); saveState(); }
        return o;
    }

    /** End the HR session: persist it for the app (it may be closed) and stop the service. */
    JSONObject endSession(String reason) {
        JSONObject f = new JSONObject();
        synchronized (this) {
            if ("recording".equals(ecgStatus) && ecgCount >= 130 * 5) saveEcg();
            stopAcc(true);
            try {
                long now = System.currentTimeMillis();
                long end = now;
                if (("strap-off".equals(reason) || "no-hr".equals(reason)) && lastHrAt > sessionStart) {
                    // the strap was taken off: the session really ended at the last valid beat, minus a few noisy seconds
                    end = Math.max(sessionStart, sessionStart + tailCutRel(rr, lastHrAt - sessionStart));
                    int cut = (int) ((end - sessionStart) / 1000);
                    while (!sess.isEmpty() && sess.get(sess.size() - 1)[0] > cut) sess.remove(sess.size() - 1);
                    while (!rr.isEmpty() && rr.get(rr.size() - 1)[0] > end - sessionStart) rr.remove(rr.size() - 1);
                }
                now = end;
                if (workoutActive) sessWorkouts.put(new JSONObject().put("id", workoutId).put("startedAt", startedAt).put("endedAt", now).put("unfinished", true));
                f.put("sessionStart", sessionStart);
                f.put("sessionEnd", now);
                f.put("reason", reason);
                f.put("deviceName", deviceName);
                f.put("workouts", new JSONArray(sessWorkouts.toString()));
                JSONArray se = new JSONArray();
                for (int[] p : sess) se.put(new JSONArray().put(p[0]).put(p[1]));
                f.put("samples", se);
                JSONArray ra = new JSONArray();
                for (int[] p : rr) ra.put(new JSONArray().put(p[0]).put(p[1]));
                f.put("rr", ra);
                if (workoutActive) f.put("unfinishedWorkout", state(0));
                appendFinished(this, f);
            } catch (Exception e) { Log.w(TAG, "endSession", e); }
            running = false;
        }
        clearSavedState(this);
        handler.removeCallbacksAndMessages(null);
        closeGatt();   // no reconnect attempts after the session is over
        try { if (sessionListener != null) sessionListener.run(); } catch (Exception ignored) {}
        if (!"user".equals(reason)) notifyDone(reason);
        try { stopForeground(true); } catch (Exception ignored) {}
        stopSelf();
        return f;
    }

    /** Set by the plugin while the app process lives: lets the web part save & sync right away, even in background. */
    static volatile Runnable sessionListener = null;

    private void notifyDone(String reason) {
        try {
            String txt = "auto-end".equals(reason) ? "Тренировка закрыта автоматически — похоже, пробежка закончилась раньше. Данные сохранены"
                : "strap-off".equals(reason) || "no-hr".equals(reason) ? "Пояс снят — запись пульса завершена и сохранена"
                : "post-done".equals(reason) ? "Восстановление записано (время вышло)" : "Мониторинг пульса завершён";
            Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
            PendingIntent pi = open != null ? PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT) : null;
            Notification.Builder b = (Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this))
                .setSmallIcon(getApplicationInfo().icon).setContentTitle(txt).setContentText("Кривая восстановления — во вкладке «Восстановление»").setAutoCancel(true);
            if (pi != null) b.setContentIntent(pi);
            getSystemService(NotificationManager.class).notify(NOTIF_ID + 1, b.build());
        } catch (Exception e) { Log.w(TAG, "notifyDone", e); }
    }

    static synchronized void appendFinished(Context ctx, JSONObject s) {
        JSONArray all = readFinished(ctx);
        all.put(s);
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), FINISHED_FILE))) { out.write(all.toString().getBytes(StandardCharsets.UTF_8)); }
        catch (Exception e) { Log.w(TAG, "appendFinished", e); }
    }

    static synchronized JSONArray readFinished(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), FINISHED_FILE);
            if (!f.exists()) return new JSONArray();
            byte[] b = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) { int r = in.read(b); }
            return new JSONArray(new String(b, StandardCharsets.UTF_8));
        } catch (Exception e) { return new JSONArray(); }
    }

    static synchronized JSONArray takeFinished(Context ctx) {
        JSONArray a = readFinished(ctx);
        new File(ctx.getFilesDir(), FINISHED_FILE).delete();
        return a;
    }

    @Override
    public void onDestroy() {
        running = false;
        { AccRecorder r = acc; if (r != null) r.flush(); }
        handler.removeCallbacksAndMessages(null);
        if (sm != null) sm.unregisterListener(this);
        if (lm != null) { try { lm.removeUpdates(locListener); } catch (Exception ignored) {} }
        closeGatt();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (instance == this) instance = null;
        super.onDestroy();
    }
}
