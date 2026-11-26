package tech.agantay.fitness;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.util.Locale;
import java.util.Random;

/**
 * v1.10: one push-up set. Listens to the proximity sensor (only works with the screen on and the app in front), counts reps with
 * PushupCounter, says every number with RepVoice. finish() stores the set in PushupStore (so it is not lost if the web part is not
 * running) and returns it. Never used while a workout is recorded (the plugin refuses).
 */
final class PushupSession implements SensorEventListener {
    static final String TAG = "PushupSession";
    static final long IDLE_END_MS = 120_000, EMPTY_END_MS = 300_000;

    interface Listener { void onRep(int reps, boolean undo); void onAutoFinished(JSONObject set, String reason); }

    private final Context ctx;
    private final SensorManager sm;
    private final Sensor prox;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final RepVoice voice;
    private PushupCounter counter;
    private Listener listener;
    private long startedAt, armedMono;
    private float maxRange = 5f;
    private boolean active = false;

    PushupSession(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        sm = (SensorManager) this.ctx.getSystemService(Context.SENSOR_SERVICE);
        prox = sm != null ? sm.getDefaultSensor(Sensor.TYPE_PROXIMITY) : null;
        voice = new RepVoice(this.ctx);
    }

    void setListener(Listener l) { listener = l; }
    boolean present() { return prox != null; }
    boolean active() { return active; }
    int reps() { return counter == null ? 0 : counter.reps(); }
    float maxRange() { return prox != null ? prox.getMaximumRange() : 0f; }
    String sensorName() { return prox != null ? prox.getName() : null; }
    boolean voiceClips() { return voice.hasClips(); }

    /** @return null if counting started, else an error code */
    synchronized String start() {
        if (active) return null;
        if (prox == null) return "no-sensor";
        maxRange = prox.getMaximumRange();
        counter = new PushupCounter(false, 0);   // the first sensor event tells the real state
        firstEvent = true;
        startedAt = System.currentTimeMillis();
        armedMono = android.os.SystemClock.elapsedRealtime();
        voice.start();
        if (!sm.registerListener(this, prox, SensorManager.SENSOR_DELAY_FASTEST, h)) { voice.stop(); return "error"; }
        active = true;
        Log.i(TAG, "start: sensor=" + prox.getName() + " maxRange=" + maxRange + " clips=" + voice.hasClips());
        h.postDelayed(idleCheck, 5_000);
        return null;
    }

    private boolean firstEvent = true;

    @Override public synchronized void onSensorChanged(SensorEvent e) {
        if (!active || e.values == null || e.values.length == 0) return;
        long ms = e.timestamp / 1_000_000L;
        boolean near = PushupCounter.isNear(e.values[0], maxRange);
        if (firstEvent) { firstEvent = false; counter = new PushupCounter(near, ms); Log.i(TAG, "first proximity value " + e.values[0] + " near=" + near); return; }
        if (counter.onProximity(ms, near)) {
            int n = counter.reps();
            Log.i(TAG, "rep " + n);
            voice.say(n);
            if (listener != null) listener.onRep(n, false);
        }
    }
    @Override public void onAccuracyChanged(Sensor s, int a) {}

    synchronized void undo() {
        if (!active || counter == null || !counter.undo()) return;
        int n = counter.reps();
        if (n > 0) voice.say(n);
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
                else if (counter.reps() == 0 && sinceStart > EMPTY_END_MS) why = "empty";
                if (why != null) set = finishLocked();
            }
            if (why != null) { if (listener != null) listener.onAutoFinished(set, why); }
            else h.postDelayed(this, 5_000);
        }
    };
    // sensor event timestamps are on the elapsed-realtime clock (ns since boot), so counter times compare with SystemClock.elapsedRealtime()

    /** stop counting; the set (null if no reps) is stored for the web part */
    synchronized JSONObject finish() { return active ? finishLocked() : null; }

    private JSONObject finishLocked() {
        active = false;
        h.removeCallbacks(idleCheck);
        try { sm.unregisterListener(this); } catch (Exception ignored) {}
        voice.stop();
        int n = counter.reps();
        if (n < 1) return null;
        try {
            double armed = (android.os.SystemClock.elapsedRealtime() - armedMono) / 1000.0;
            JSONObject o = new JSONObject()
                .put("id", String.format(Locale.ROOT, "pu-%d-%03d", startedAt, new Random().nextInt(1000)))
                .put("t", startedAt).put("reps", n)
                .put("duration_s", Math.round(counter.activeSeconds() * 10) / 10.0)
                .put("armed_s", Math.round(armed * 10) / 10.0).put("source", "proximity");
            PushupStore.add(ctx, o);
            return o;
        } catch (Exception e) { Log.w(TAG, "finish", e); return null; }
    }
}
