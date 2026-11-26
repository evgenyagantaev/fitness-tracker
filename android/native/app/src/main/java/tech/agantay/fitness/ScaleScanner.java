package tech.agantay.fitness;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.ParcelUuid;
import android.util.Log;

import java.util.Collections;

/**
 * Listens for Mi Scale 2 advertisements (no connection, no pairing). Passive scan only: it never touches GATT,
 * so the H10 connection is not affected. Final readings go to ScaleStore; every frame goes to the listener (live UI).
 */
final class ScaleScanner {
    private static final String TAG = "ScaleScanner";
    interface Listener { void onFrame(MiScale.Reading r, String device, boolean saved); }

    private final Context ctx;
    private final boolean lowPower;
    private volatile Listener listener;
    private BluetoothLeScanner scanner;
    private boolean on = false;

    ScaleScanner(Context ctx, boolean lowPower) { this.ctx = ctx.getApplicationContext(); this.lowPower = lowPower; }

    void setListener(Listener l) { listener = l; }
    boolean isOn() { return on; }

    static boolean permitted(Context ctx) {
        if (Build.VERSION.SDK_INT >= 31)
            return ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
        return ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private final ScanCallback cb = new ScanCallback() {
        @Override public void onScanResult(int type, ScanResult res) { handle(res); }
        @Override public void onScanFailed(int code) { Log.w(TAG, "scan failed " + code); on = false; }
    };

    private void handle(ScanResult res) {
        try {
            ScanRecord rec = res.getScanRecord();
            if (rec == null) return;
            byte[] d = rec.getServiceData(ParcelUuid.fromString(MiScale.SERVICE_UUID));
            MiScale.Reading r = MiScale.parse(d);
            if (r == null) return;
            String dev = res.getDevice() != null ? res.getDevice().getAddress() : null;
            boolean saved = r.isFinal() && ScaleStore.add(ctx, r, dev);
            Listener l = listener;
            if (l != null) l.onFrame(r, dev, saved);
        } catch (Exception e) { Log.w(TAG, "frame", e); }
    }

    /** @return null if started, otherwise the reason */
    @SuppressLint("MissingPermission")
    synchronized String start() {
        if (on) return null;
        if (!permitted(ctx)) return "no-permission";
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter ad = bm != null ? bm.getAdapter() : null;
        if (ad == null) return "no-bluetooth";
        if (!ad.isEnabled()) return "bluetooth-off";
        scanner = ad.getBluetoothLeScanner();
        if (scanner == null) return "bluetooth-off";
        // filter on the service data UUID (empty data = any payload): works with the screen off and costs little
        ScanFilter f = new ScanFilter.Builder().setServiceData(ParcelUuid.fromString(MiScale.SERVICE_UUID), new byte[0]).build();
        ScanSettings s = new ScanSettings.Builder()
            .setScanMode(lowPower ? ScanSettings.SCAN_MODE_LOW_POWER : ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        try { scanner.startScan(Collections.singletonList(f), s, cb); on = true; return null; }
        catch (Exception e) { Log.w(TAG, "start", e); return "error"; }
    }

    @SuppressLint("MissingPermission")
    synchronized void stop() {
        if (!on) return;
        on = false;
        try { if (scanner != null) scanner.stopScan(cb); } catch (Exception e) { Log.w(TAG, "stop", e); }
    }
}
