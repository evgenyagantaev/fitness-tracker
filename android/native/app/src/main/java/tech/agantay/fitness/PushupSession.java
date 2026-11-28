package tech.agantay.fitness;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.util.Log;

import org.json.JSONObject;

import java.util.Locale;
import java.util.Random;

/**
 * v1.10: one push-up set. Listens to the proximity sensor (only works with the screen on and the app in front), counts reps with
 * PushupCounter, says every number with RepVoice. finish() stores the set in PushupStore (so it is not lost if the web part is not
 * running) and returns it. Never used while a workout is recorded (the plugin refuses).
 * v1.14: leaving to Recents / Home / screen off pauses the set (the sensor is silent in the background) instead of finishing it.
 * The count is kept in memory and in {@link PushupLive}; coming back re-registers the sensor and continues. The 2-minute idle
 * close still runs while paused, and after a process death the snapshot is closed on the next start if it has expired.
 * v1.18.1: the same native countdown as pull-ups (voice 5…1, then a beep and a buzz). Proximity events before the ready
 * signal are ignored, so a chest already on the phone during the countdown is not a rep.
 */
final class PushupSession implements SensorEventListener {
    static final String TAG = "PushupSession";
    static final long IDLE_END_MS = 120_000, EMPTY_END_MS = 300_000;

    interface Listener {
        void onRep(int reps, boolean undo);
        void onAutoFinished(JSONObject set, String reason);
        default void onState(JSONObject st) {}
    }

    private final Context ctx;
    private final SensorManager sm;
    private final Sensor prox;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final RepVoice voice;
    private PushupCounter counter;
    private Listener listener;
    private long startedAt, armedMono;
    private String setId;
    private float maxRange = 5f;
    private boolean active = false, paused = false, restored = false, counting = false;
    private int countdownLeft = 0;
    private long goMono;

    PushupSession(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        sm = (SensorManager) this.ctx.getSystemService(Context.SENSOR_SERVICE);
        prox = sm != null ? sm.getDefaultSensor(Sensor.TYPE_PROXIMITY) : null;
        voice = new RepVoice(this.ctx);
    }

    void setListener(Listener l) { listener = l; }
    boolean present() { return prox != null; }
    boolean active() { return active; }
    boolean paused() { return active && paused; }
    /** true once after the set was rebuilt from disk (the app had been killed): the caller opens it unlocked */
    synchronized boolean takeRestored() { boolean r = restored; restored = false; return r; }
    int reps() { return counter == null ? 0 : counter.reps(); }
    float maxRange() { return prox != null ? prox.getMaximumRange() : 0f; }
    String sensorName() { return prox != null ? prox.getName() : null; }
    boolean voiceClips() { return voice.hasClips(); }
    synchronized int countdownLeft() { return active && !counting ? countdownLeft : 0; }
    synchronized boolean counting() { return active && counting; }

    synchronized JSONObject state() {
        JSONObject o = new JSONObject();
        try {
            o.put("active", active).put("reps", reps()).put("countdown", countdownLeft())
                .put("counting", counting).put("paused", paused);
        } catch (Exception ignored) {}
        return o;
    }

    /** @return null if started, else an error code. Countdown is 8 s by default, same as pull-ups. */
    synchronized String start() { return start(8); }

    /** @return null if started, else an error code */
    synchronized String start(int countdownSec) {
        if (active) return null;
        if (prox == null) return "no-sensor";
        countdownSec = Math.max(3, Math.min(30, countdownSec));
        maxRange = prox.getMaximumRange();
        counter = new PushupCounter(false, 0);   // the first sensor event tells the real state
        firstEvent = true;
        startedAt = System.currentTimeMillis();
        armedMono = android.os.SystemClock.elapsedRealtime();
        goMono = 0;
        setId = String.format(Locale.ROOT, "pu-%d-%03d", startedAt, new Random().nextInt(1000));
        paused = false;
        counting = false;
        countdownLeft = countdownSec;
        voice.start();
        if (!sm.registerListener(this, prox, SensorManager.SENSOR_DELAY_FASTEST, h)) { voice.stop(); return "error"; }
        active = true;
        h.removeCallbacks(idleCheck);
        h.removeCallbacks(tick);
        h.removeCallbacks(goRun);
        h.post(tick);
        h.postDelayed(idleCheck, 5_000);
        Log.i(TAG, "start id=" + setId + " countdown=" + countdownSec + " sensor=" + prox.getName() + " maxRange=" + maxRange + " clips=" + voice.hasClips());
        return null;
    }

    private boolean firstEvent = true;

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            boolean goNow = false; JSONObject st;
            synchronized (PushupSession.this) {
                if (!active || paused) return;
                if (!counting && countdownLeft > 0) {
                    if (countdownLeft <= 5) voice.say(countdownLeft);
                    countdownLeft--;
                    if (countdownLeft == 0) goNow = true;
                }
                st = state();
            }
            notifyState(st);
            if (goNow) h.postDelayed(goRun, 1000);
            else {
                synchronized (PushupSession.this) {
                    if (active && !paused && !counting && countdownLeft > 0) h.postDelayed(this, 1000);
                }
            }
        }
    };

    private final Runnable goRun = this::go;

    private void go() {
        JSONObject st;
        synchronized (this) {
            if (!active || paused || counting) return;
            counting = true;
            countdownLeft = 0;
            goMono = android.os.SystemClock.elapsedRealtime();
            persist();
            st = state();
        }
        beep();
        notifyState(st);
        Log.i(TAG, "go");
    }

    /** same ready signal as pull-ups: TONE_PROP_BEEP2 and a 350 ms vibration */
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

    private void notifyState(JSONObject st) {
        Listener l = listener;
        if (l != null) { try { l.onState(st); } catch (Exception ignored) {} }
    }

    @Override public synchronized void onSensorChanged(SensorEvent e) {
        if (!active || e.values == null || e.values.length == 0) return;
        long ms = e.timestamp / 1_000_000L;
        boolean near = PushupCounter.isNear(e.values[0], maxRange);
        if (firstEvent) { firstEvent = false; counter = new PushupCounter(near, ms); Log.i(TAG, "first proximity value " + e.values[0] + " near=" + near); return; }
        if (!counting) return;   // chest already on the phone during the countdown is not a rep
        if (counter.onProximity(ms, near)) {
            int n = counter.reps();
            Log.i(TAG, "rep " + n);
            voice.say(n);
            persist();
            if (listener != null) listener.onRep(n, false);
        }
    }
    @Override public void onAccuracyChanged(Sensor s, int a) {}

    synchronized void undo() {
        if (!active || counter == null || !counter.undo()) return;
        int n = counter.reps();
        if (n > 0) voice.say(n);
        persist();
        if (listener != null) listener.onRep(n, true);
    }

    private final Runnable idleCheck = new Runnable() {
        @Override public void run() {
            JSONObject set = null; String why = null;
            synchronized (PushupSession.this) {
                if (!active) return;
                long now = android.os.SystemClock.elapsedRealtime();
                long sinceStart = now - armedMono;
                long lastRepAgo = counter.reps() > 0 ? (now - counter.lastRepMs()) : -1;
                if (counter.reps() > 0 && lastRepAgo > IDLE_END_MS) why = "idle";
                else if (counting && counter.reps() == 0 && goMono > 0 && now - goMono > EMPTY_END_MS) why = "empty";
                else if (!counting && sinceStart > EMPTY_END_MS) why = "empty";
                if (why != null) set = finishLocked();
            }
            if (why != null) { if (listener != null) listener.onAutoFinished(set, why); }
            else h.postDelayed(this, 5_000);
        }
    };
    // sensor event timestamps are on the elapsed-realtime clock (ns since boot), so counter times compare with SystemClock.elapsedRealtime()

    /** drop the sensor and the speaker, keep the count; the idle timer keeps running */
    synchronized void pause() {
        if (!active || paused) return;
        paused = true;
        h.removeCallbacks(tick);
        h.removeCallbacks(goRun);
        try { sm.unregisterListener(this); } catch (Exception ignored) {}
        voice.stop();
        if (counting) persist();
        Log.i(TAG, "paused at " + reps() + " reps, counting=" + counting + " countdown=" + countdownLeft);
    }

    /** @return null if counting resumed, else an error code */
    synchronized String resume() {
        if (!active) return "idle";
        if (!paused) return null;
        if (prox == null) return "no-sensor";
        firstEvent = true;   // the first reading after a gap only syncs near/far, it does not count a rep
        voice.start();
        if (!sm.registerListener(this, prox, SensorManager.SENSOR_DELAY_FASTEST, h)) { voice.stop(); return "error"; }
        paused = false;
        int n = reps();
        if (counting && n > 0) voice.say(n);
        if (!counting && countdownLeft > 0) h.post(tick);
        else if (!counting) h.post(goRun);
        Log.i(TAG, "resumed at " + n + " reps, counting=" + counting + " countdown=" + countdownLeft);
        return null;
    }

    /** rebuild a paused set from a {@link PushupLive} snapshot; starts the idle timer, does not touch the sensor */
    synchronized void restore(JSONObject live) {
        if (live == null) return;
        if (active) finishLocked();
        long nowWall = System.currentTimeMillis();
        long nowMono = android.os.SystemClock.elapsedRealtime();
        startedAt = live.optLong("startedAt", nowWall);
        setId = live.optString("id", String.format(Locale.ROOT, "pu-%d-%03d", startedAt, new Random().nextInt(1000)));
        long armedAgo = Math.max(0, nowWall - startedAt);
        armedMono = nowMono - armedAgo;
        counter = PushupCounter.fromSnapshot(live, nowWall, nowMono);
        firstEvent = true;
        paused = true;
        counting = true;
        countdownLeft = 0;
        goMono = nowMono;
        active = true;
        restored = true;
        maxRange = prox != null ? prox.getMaximumRange() : 5f;
        Log.i(TAG, "restored " + reps() + " reps, paused, id=" + setId);
        h.removeCallbacks(idleCheck);
        h.postDelayed(idleCheck, 1_000);
    }

    private void persist() {
        if (!active || !counting || counter == null) return;
        try {
            long nowWall = System.currentTimeMillis();
            long nowMono = android.os.SystemClock.elapsedRealtime();
            JSONObject o = new JSONObject().put("id", setId == null ? "" : setId).put("startedAt", startedAt);
            counter.putSnapshot(o, nowWall, nowMono);
            PushupLive.write(ctx, o);
        } catch (Exception ignored) {}
    }

    /** stop counting; the set (null if no reps) is stored for the web part */
    synchronized JSONObject finish() { return active ? finishLocked() : null; }

    private JSONObject finishLocked() {
        active = false;
        paused = false;
        counting = false;
        countdownLeft = 0;
        h.removeCallbacks(idleCheck);
        h.removeCallbacks(tick);
        h.removeCallbacks(goRun);
        try { sm.unregisterListener(this); } catch (Exception ignored) {}
        voice.stop();
        PushupLive.clear(ctx);
        int n = counter == null ? 0 : counter.reps();
        if (n < 1) return null;
        try {
            double armed = (android.os.SystemClock.elapsedRealtime() - armedMono) / 1000.0;
            JSONObject o = new JSONObject()
                .put("id", setId != null ? setId : String.format(Locale.ROOT, "pu-%d-%03d", startedAt, new Random().nextInt(1000)))
                .put("t", startedAt).put("reps", n)
                .put("duration_s", Math.round(counter.activeSeconds() * 10) / 10.0)
                .put("armed_s", Math.round(armed * 10) / 10.0).put("source", "proximity");
            PushupStore.add(ctx, o);
            return o;
        } catch (Exception e) { Log.w(TAG, "finish", e); return null; }
    }
}
