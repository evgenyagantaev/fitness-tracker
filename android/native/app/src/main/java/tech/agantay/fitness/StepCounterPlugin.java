package tech.agantay.fitness;

import android.Manifest;
import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Minimal wrapper around Sensor.TYPE_STEP_COUNTER (hardware counter of steps since boot).
 * JS: start() -> "steps" events {steps (since start), total (since boot)}; stop(); getSteps().
 */
@CapacitorPlugin(
    name = "StepCounter",
    permissions = { @Permission(alias = "activity", strings = { Manifest.permission.ACTIVITY_RECOGNITION }) }
)
public class StepCounterPlugin extends Plugin implements SensorEventListener {
    private SensorManager sm;
    private Sensor sensor;
    private boolean running = false;
    private float baseline = -1;
    private float last = -1;

    @Override
    public void load() {
        sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        sensor = sm != null ? sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) : null;
    }

    private boolean needsRuntimePermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", sensor != null);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (sensor == null) { call.reject("На телефоне нет датчика шагов", "UNAVAILABLE"); return; }
        if (needsRuntimePermission() && getPermissionState("activity") != PermissionState.GRANTED) {
            requestPermissionForAlias("activity", call, "permCallback");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        if (getPermissionState("activity") == PermissionState.GRANTED) doStart(call);
        else call.reject("Нет разрешения «Физическая активность»", "DENIED");
    }

    private void doStart(PluginCall call) {
        boolean reset = call.getBoolean("reset", true);
        if (reset) { baseline = -1; last = -1; }
        if (!running) {
            sm.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL, 0);
            running = true;
        }
        call.resolve(state());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (running) { sm.unregisterListener(this); running = false; }
        call.resolve(state());
    }

    @PluginMethod
    public void getSteps(PluginCall call) {
        call.resolve(state());
    }

    private JSObject state() {
        JSObject r = new JSObject();
        r.put("running", running);
        r.put("steps", (baseline >= 0 && last >= 0) ? Math.round(last - baseline) : 0);
        r.put("total", last >= 0 ? Math.round(last) : -1);
        return r;
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        float v = e.values[0];
        if (baseline < 0 || v < baseline) baseline = v;   // first event, or counter reset by reboot
        last = v;
        notifyListeners("steps", state());
    }

    @Override
    public void onAccuracyChanged(Sensor s, int a) {}

    @Override
    protected void handleOnDestroy() {
        if (running && sm != null) sm.unregisterListener(this);
        running = false;
    }
}
