package tech.agantay.fitness;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.os.SystemClock;
import android.os.Vibrator;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.Locale;
import java.util.Random;

/**
 * v1.17: one pull-up set counted on the phone accelerometer ({@link PullupCounter}). Runs on its own thread under a partial
 * wake lock and a foreground service, so it keeps counting with the screen off, in a pocket or on the neck. The power button,
 * Home and Recents do not end it; it ends by itself (landing / no reps), by the notification button or from the app.
 * Countdown first (voice 5…1, then a beep and a buzz), every rep is said aloud. The raw accelerometer goes with the set.
 */
final class PullupSession implements SensorEventListener {
    static final String TAG = "PullupSession";
    static final int RATE_US = 10_000;            // 100 Hz
    static final long MAX_SET_MS = 10 * 60_000L;
    static final String PARAMS = "v1";

    interface Listener { void onState(JSONObject state); void onFinished(JSONObject set, String reason); }

    private static PullupSession inst;
    static synchronized PullupSession get(Context c) { if (inst == null) inst = new PullupSession(c.getApplicationContext()); return inst; }

    private final Context ctx;
    private final SensorManager sm;
    private final Sensor acc;
    private final RepVoice voice;
    private HandlerThread thread;
    private Handler h;
    private PowerManager.WakeLock wl;
    private volatile Listener listener;

    private PullupCounter counter;
    private PullupRaw raw;
    private boolean active = false;
    private int countdownLeft = 0;
    private long startedWall, goWall, goMono, startMono;
    private String setId;
    private long lastEventMono = 0;
    private int samples = 0;
    private volatile boolean closing = false;

    private PullupSession(Context c) {
        ctx = c;
        sm = (SensorManager) c.getSystemService(Context.SENSOR_SERVICE);
        acc = sm != null ? sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) : null;
        voice = new RepVoice(c);
    }

    void setListener(Listener l) { listener = l; }
    boolean present() { return acc != null; }
    synchronized boolean active() { return active; }
    synchronized int reps() { return counter == null ? 0 : counter.reps(); }
    synchronized int countdownLeft() { return active ? countdownLeft : 0; }

    JSONObject sensorInfo() {
        JSONObject o = new JSONObject();
        if (acc == null) return o;
        try {
            o.put("name", acc.getName()).put("vendor", acc.getVendor()).put("resolution", acc.getResolution())
             .put("max_range", acc.getMaximumRange()).put("min_delay_us", acc.getMinDelay()).put("max_delay_us", acc.getMaxDelay())
             .put("fifo", acc.getFifoMaxEventCount()).put("wakeup", acc.isWakeUpSensor()).put("power_ma", acc.getPower());
        } catch (Exception ignored) {}
        return o;
    }

    synchronized JSONObject state() {
        JSONObject o = new JSONObject();
        try {
            o.put("active", active).put("reps", counter == null ? 0 : counter.reps()).put("countdown", active ? countdownLeft : 0)
             .put("id", setId == null ? JSONObject.NULL : setId).put("samples", samples)
             .put("sensorOk", active && SystemClock.elapsedRealtime() - lastEventMono < 3000);
        } catch (Exception ignored) {}
        return o;
    }

    /** @return null if started, else an error code */
    synchronized String start(int countdownSec) {
        if (active) return null;
        if (acc == null) return "no-sensor";
        countdownSec = Math.max(3, Math.min(30, countdownSec));
        if (thread == null) { thread = new HandlerThread("pullup"); thread.start(); h = new Handler(thread.getLooper()); }
        counter = new PullupCounter();
        raw = new PullupRaw();
        samples = 0;
        startedWall = System.currentTimeMillis();
        startMono = SystemClock.elapsedRealtime();
        goWall = 0; goMono = 0;
        lastEventMono = startMono;
        setId = String.format(Locale.ROOT, "pl-%d-%03d", startedWall, new Random().nextInt(1000));
        countdownLeft = countdownSec;
        closing = false;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fitness:pullups");
            wl.setReferenceCounted(false);
            wl.acquire(MAX_SET_MS + 120_000L);
        } catch (Exception e) { Log.w(TAG, "wakelock", e); }
        voice.start();
        if (!sm.registerListener(this, acc, RATE_US, 0, h)) { voice.stop(); releaseWl(); return "error"; }
        active = true;
        PullupService.start(ctx);
        writeLive();
        h.post(tick);
        Log.i(TAG, "start id=" + setId + " countdown=" + countdownSec + " sensor=" + acc.getName());
        return null;
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            boolean goNow = false; JSONObject st;
            synchronized (PullupSession.this) {
                if (!active) return;
                if (countdownLeft > 0) {
                    if (countdownLeft <= 5) voice.say(countdownLeft);
                    countdownLeft--;
                    if (countdownLeft == 0) goNow = true;
                } else if (SystemClock.elapsedRealtime() - startMono > MAX_SET_MS) {
                    finishAsync("limit");
                }
                st = state();
            }
            if (goNow) h.postDelayed(PullupSession.this::go, 1000);
            else if (countdownLeft > 0) h.postDelayed(this, 1000);
            else h.postDelayed(this, 5000);
            notifyState(st);
            PullupService.update(ctx);
        }
    };

    private void go() {
        JSONObject st;
        synchronized (this) {
            if (!active) return;
            goMono = SystemClock.elapsedRealtime();
            goWall = System.currentTimeMillis();
            counter.go(goMono);
            st = state();
        }
        beep();
        h.postDelayed(tick, 5000);
        notifyState(st);
        PullupService.update(ctx);
        Log.i(TAG, "go");
    }

    private void beep() {
        try {
            ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_MUSIC, 90);
            tg.startTone(ToneGenerator.TONE_PROP_BEEP2, 350);
            h.postDelayed(tg::release, 800);
        } catch (Exception e) { Log.w(TAG, "beep", e); }
        try {
            Vibrator vb = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (vb != null) {
                if (android.os.Build.VERSION.SDK_INT >= 26) vb.vibrate(android.os.VibrationEffect.createOneShot(350, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
                else vb.vibrate(350);
            }
        } catch (Exception ignored) {}
    }

    @Override public void onSensorChanged(SensorEvent e) {
        boolean rep = false; String close = null; int n = 0;
        synchronized (this) {
            if (!active || e.values == null || e.values.length < 3) return;
            long ms = e.timestamp / 1_000_000L;   // elapsed-realtime clock, same as SystemClock.elapsedRealtime()
            lastEventMono = SystemClock.elapsedRealtime();
            samples++;
            raw.add(ms, System.currentTimeMillis(), e.values[0], e.values[1], e.values[2]);
            rep = counter.onSample(ms, e.values[0], e.values[1], e.values[2]);
            n = counter.reps();
            if (counter.counting()) close = counter.closeReason();
        }
        if (rep) {
            voice.say(n);
            writeLive();
            Log.i(TAG, "rep " + n);
            notifyState(state());
            PullupService.update(ctx);
        }
        if (close != null && !closing) { closing = true; finishAsync(close); }
    }
    @Override public void onAccuracyChanged(Sensor s, int a) {}

    synchronized void undo() {
        if (!active || counter == null || !counter.undo()) return;
        int n = counter.reps();
        if (n > 0) voice.say(n);
        writeLive();
        h.post(() -> { notifyState(state()); PullupService.update(ctx); });
    }

    /** finish on the session thread and tell the listener */
    void finishAsync(String reason) {
        Runnable r = () -> {
            if (!active()) return;   // already closed (several samples may ask)
            JSONObject set = finish(reason);
            Listener l = listener; if (l != null) l.onFinished(set, reason);
        };
        if (h != null) h.post(r); else r.run();
    }

    /** stop counting; the set (null if no reps) is stored for the web part and returned */
    synchronized JSONObject finish(String reason) {
        if (!active) return null;
        active = false;
        countdownLeft = 0;
        try { sm.unregisterListener(this); } catch (Exception ignored) {}
        if (h != null) h.removeCallbacksAndMessages(null);
        PullupService.stop(ctx);
        PullupStore.clearLive(ctx);
        int n = counter == null ? 0 : counter.reps();
        voice.stop();
        if (n > 0) VoiceSpeaker.get(ctx).sayNow("Записано " + RuNum.words(n) + ".");
        else VoiceSpeaker.get(ctx).sayNow("Подход без повторов.");
        JSONObject set = null;
        if (n > 0) {
            try {
                List<Long> rt = counter.repTimes();
                long base = goMono > 0 ? goMono : startMono;
                JSONArray offs = new JSONArray();
                for (Long t : rt) offs.put(t - base);
                double dur = n < 2 ? 0 : (rt.get(rt.size() - 1) - rt.get(0)) / 1000.0;
                double armed = (SystemClock.elapsedRealtime() - startMono) / 1000.0;
                set = new JSONObject()
                    .put("id", setId).put("t", goWall > 0 ? goWall : startedWall).put("reps", n)
                    .put("duration_s", Math.round(dur * 10) / 10.0).put("armed_s", Math.round(armed * 10) / 10.0)
                    .put("source", "accel").put("device", android.os.Build.MODEL)
                    .put("close", reason == null ? "app" : reason).put("rep_ms", offs).put("params", PARAMS)
                    .put("sensor", sensorInfo())
                    .put("raw_fmt", "pullraw1").put("raw_t0", raw.t0Wall).put("raw_n", raw.samples())
                    .put("raw_go_ms", goWall > 0 ? goWall - raw.t0Wall : JSONObject.NULL)
                    .put("raw_truncated", raw.truncated).put("raw", raw.encode());
                PullupStore.add(ctx, set);
            } catch (Exception e) { Log.w(TAG, "finish", e); set = null; }
        }
        releaseWl();
        Log.i(TAG, "finish reps=" + n + " reason=" + reason + " samples=" + samples);
        counter = null; raw = null;
        return set;
    }

    private void releaseWl() { try { if (wl != null && wl.isHeld()) wl.release(); } catch (Exception ignored) {} wl = null; }

    private void notifyState(JSONObject st) { Listener l = listener; if (l != null) { try { l.onState(st); } catch (Exception ignored) {} } }

    private void writeLive() {
        try {
            JSONObject o;
            synchronized (this) {
                if (!active) return;
                o = new JSONObject().put("id", setId).put("t", goWall > 0 ? goWall : startedWall)
                    .put("reps", counter.reps()).put("updated", System.currentTimeMillis());
            }
            PullupStore.writeLive(ctx, o);
        } catch (Exception ignored) {}
    }

    /** after a process death: a leftover live record becomes a finished set (count only, no raw) */
    static JSONObject recoverLeftover(Context c) {
        if (get(c).active()) return null;
        JSONObject live = PullupStore.readLive(c);
        if (live == null) return null;
        PullupStore.clearLive(c);
        int n = live.optInt("reps");
        if (n < 1) return null;
        try {
            JSONObject set = new JSONObject().put("id", live.optString("id")).put("t", live.optLong("t")).put("reps", n)
                .put("duration_s", 0).put("armed_s", 0).put("source", "accel").put("device", android.os.Build.MODEL)
                .put("close", "recovered").put("params", PARAMS);
            PullupStore.add(c, set);
            return set;
        } catch (Exception e) { return null; }
    }
}
