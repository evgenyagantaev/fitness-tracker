package tech.agantay.fitness;

import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.util.zip.Deflater;

/**
 * v1.17: raw phone accelerometer of one pull-up set, for tuning the counter on real sets.
 * Format "pullraw1": per sample 4 × int16 LE = [dt_ms since the previous sample, ax, ay, az in 0.01 m/s²],
 * zlib-deflated, then base64. First dt is 0; t of the first sample = raw_t0 (wall ms).
 */
final class PullupRaw {
    static final int MAX_SAMPLES = 100 * 60 * 6;   // 6 minutes at 100 Hz
    private short[] buf = new short[4 * 100 * 60];
    private int n = 0;
    private long lastMs = -1;
    long t0Wall = 0;
    boolean truncated = false;

    synchronized void add(long ms, long wall, float ax, float ay, float az) {
        if (n >= MAX_SAMPLES) { truncated = true; return; }
        if (n == 0) t0Wall = wall;
        if (4 * (n + 1) > buf.length) { short[] b = new short[buf.length * 2]; System.arraycopy(buf, 0, b, 0, 4 * n); buf = b; }
        long dt = lastMs < 0 ? 0 : Math.max(0, Math.min(Short.MAX_VALUE, ms - lastMs));
        lastMs = ms;
        int o = 4 * n;
        buf[o] = (short) dt; buf[o + 1] = q(ax); buf[o + 2] = q(ay); buf[o + 3] = q(az);
        n++;
    }
    private static short q(float v) { return (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, Math.round(v * 100f))); }
    synchronized int samples() { return n; }

    synchronized String encode() {
        byte[] b = new byte[8 * n];
        for (int i = 0; i < 4 * n; i++) { b[2 * i] = (byte) (buf[i] & 0xff); b[2 * i + 1] = (byte) ((buf[i] >> 8) & 0xff); }
        Deflater d = new Deflater(Deflater.BEST_COMPRESSION);
        d.setInput(b); d.finish();
        ByteArrayOutputStream out = new ByteArrayOutputStream(b.length / 2 + 64);
        byte[] chunk = new byte[16384];
        while (!d.finished()) { int k = d.deflate(chunk); out.write(chunk, 0, k); }
        d.end();
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }
}
