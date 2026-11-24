package tech.agantay.fitness;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Polar H10 accelerometer (PMD measurement type 2) → raw file on disk, written while the run goes on.
 * Directory acc/&lt;id&gt;/: data.bin = int16 LE x,y,z in mG per sample; frames.csv = "samplesSoFar,sensorMs,wallMs" per BLE frame
 * (sensor clock = ns since 2000 → ms; the server maps it to wall clock); meta.json = settings + complete flag.
 * Also a light real-time step detector on |a| (the full analysis is done offline from the raw file).
 */
class AccRecorder {
    static final String DIR = "acc";
    static final int FS = 200, RANGE_G = 8;
    /** start ACC: type 2; sample rate 200 Hz; resolution 16 bit; range 8 g */
    static final byte[] START = { 0x02, 0x02, 0x00, 0x01, (byte) 0xC8, 0x00, 0x01, 0x01, 0x10, 0x00, 0x02, 0x01, 0x08, 0x00 };
    static final byte[] STOP = { 0x03, 0x02 };

    final File dir;
    final String id;
    boolean test;
    /** "h10" (chest strap, 200 Hz) or "phone" (beltless run: the phone's own accelerometer, ~50 Hz, magnitude profile only) */
    String source = "h10"; int fsNom = FS; int frameEvery = 50;
    private OutputStream data, frames;
    long samples = 0, framesN = 0, firstSensorNs = -1, startedAt;
    int lastFrameType = -1, badFrames = 0;
    int flushEvery = 10;
    // real-time steps: |a| high-passed, peak with refractory period
    int steps = 0; private double base = 1000, lp = 1000; private long lastPeakIdx = -1000; private boolean above = false; private double peak = 0; private long peakIdx = 0, stepIdx = 0;

    AccRecorder(File root, String id, long startedAt, String device, String workoutId, boolean test) throws IOException {
        this.id = id; this.startedAt = startedAt; this.test = test;
        dir = new File(new File(root, DIR), id); dir.mkdirs();
        boolean resume = new File(dir, "data.bin").exists();
        if (resume) {
            // the app may have been killed mid-write: keep whole samples and whole frame lines only
            File d = new File(dir, "data.bin");
            samples = d.length() / 6;
            try (java.io.RandomAccessFile r = new java.io.RandomAccessFile(d, "rw")) { r.setLength(samples * 6); }
            File f = new File(dir, "frames.csv");
            if (f.exists() && f.length() > 0) {
                try (java.io.RandomAccessFile r = new java.io.RandomAccessFile(f, "rw")) {
                    long len = r.length(), p = len - 1;
                    while (p >= 0) { r.seek(p); if (r.read() == '\n') break; p--; }
                    r.setLength(p + 1);
                }
            }
            steps = readMetaInt("steps_rt");
            try { JSONObject m = meta(); source = m.optString("source", "h10"); fsNom = m.optInt("fs", FS); } catch (Exception ignored) {}
        }
        data = new BufferedOutputStream(new FileOutputStream(new File(dir, "data.bin"), true), 64 * 1024);
        frames = new BufferedOutputStream(new FileOutputStream(new File(dir, "frames.csv"), true), 8 * 1024);
        if (!resume) writeMeta(device, workoutId, test, false);
    }

    private int readMetaInt(String k) {
        try { return meta().optInt(k, 0); } catch (Exception e) { return 0; }
    }
    JSONObject meta() throws Exception {
        File f = new File(dir, "meta.json");
        byte[] b = new byte[(int) f.length()];
        try (FileInputStream in = new FileInputStream(f)) { int r = in.read(b); }
        return new JSONObject(new String(b, StandardCharsets.UTF_8));
    }
    void writeMeta(String device, String workoutId, boolean testIgnored, boolean complete) {
        try {
            JSONObject o;
            try { o = meta(); } catch (Exception e) { o = new JSONObject(); }
            o.put("id", id); o.put("fs", fsNom); o.put("source", source); o.put("range_g", RANGE_G); o.put("unit", "mG"); o.put("started_at", startedAt);
            if (device != null) o.put("device", device);
            if (workoutId != null) o.put("workout_id", workoutId);
            o.put("test", test); o.put("complete", complete); o.put("samples", samples); o.put("steps_rt", steps); o.put("frames", framesN);
            o.put("frame_type", lastFrameType); o.put("bad_frames", badFrames); o.put("format", "int16le-xyz");
            try (FileOutputStream out = new FileOutputStream(new File(dir, "meta.json"))) { out.write(o.toString().getBytes(StandardCharsets.UTF_8)); }
        } catch (Exception ignored) {}
    }

    /** Phone accelerometer: one sample (m/s²) → int16 mG into the same file format; a frame line every `frameEvery` samples. */
    private long lastSensorNs = 0, lastWallMs = 0;
    synchronized void onPhoneSample(long sensorNs, float ax, float ay, float az, long wallMs) {
        try {
            if (firstSensorNs < 0) firstSensorNs = sensorNs;
            byte[] b = new byte[6]; float[] v = { ax, ay, az };
            for (int c = 0; c < 3; c++) {
                int x = Math.max(-32768, Math.min(32767, Math.round(v[c] / 9.80665f * 1000f)));
                b[2 * c] = (byte) (x & 0xff); b[2 * c + 1] = (byte) ((x >> 8) & 0xff);
            }
            data.write(b);
            samples++; lastSensorNs = sensorNs; lastWallMs = wallMs;
            if (samples % frameEvery == 0) {
                frames.write((samples + "," + (sensorNs / 1_000_000L) + "," + wallMs + "\n").getBytes(StandardCharsets.US_ASCII));
                framesN++;
                if (framesN % 20 == 0) { data.flush(); frames.flush(); }
                if (framesN % 400 == 0) writeMeta(null, null, false, false);
            }
        } catch (IOException e) { badFrames++; }
    }

    /** One PMD data notification. Returns number of samples added. */
    synchronized int onFrame(byte[] v, long wallMs) {
        if (v == null || v.length < 10 || v[0] != 0x02) return 0;
        long ts = 0; for (int i = 8; i >= 1; i--) ts = (ts << 8) | (v[i] & 0xff);
        int ft = v[9] & 0xff;
        int[][] xyz = parse(v, ft);
        if (xyz == null) { badFrames++; return 0; }
        lastFrameType = ft;
        if (firstSensorNs < 0) firstSensorNs = ts;
        try {
            byte[] b = new byte[xyz.length * 6];
            for (int i = 0; i < xyz.length; i++) for (int c = 0; c < 3; c++) {
                int x = Math.max(-32768, Math.min(32767, xyz[i][c]));
                b[6 * i + 2 * c] = (byte) (x & 0xff); b[6 * i + 2 * c + 1] = (byte) ((x >> 8) & 0xff);
            }
            data.write(b);
            for (int[] s : xyz) step(s);
            samples += xyz.length; framesN++;
            frames.write((samples + "," + (ts / 1_000_000L) + "," + wallMs + "\n").getBytes(StandardCharsets.US_ASCII));
            if (framesN % flushEvery == 0) { data.flush(); frames.flush(); }
            if (framesN % 200 == 0) writeMeta(null, null, false, false);
        } catch (IOException e) { badFrames++; }
        return xyz.length;
    }

    /** Raw frames: type 0/1/2 = 8/16/24-bit signed x,y,z. Compressed (bit 7): reference sample + delta blocks. */
    static int[][] parse(byte[] v, int ft) {
        int type = ft & 0x7f; boolean delta = (ft & 0x80) != 0;
        int n = v.length - 10;
        if (!delta) {
            int sz = type == 0 ? 1 : type == 1 ? 2 : type == 2 ? 3 : -1;
            if (sz < 0 || n <= 0 || n % (3 * sz) != 0) return null;
            int cnt = n / (3 * sz); int[][] out = new int[cnt][3];
            for (int i = 0; i < cnt; i++) for (int c = 0; c < 3; c++) out[i][c] = signed(v, 10 + (3 * i + c) * sz, sz);
            return out;
        }
        int res = type == 0 ? 8 : 16;   // compressed type 0 → 8-bit ref, type 1 → 16-bit ref
        int rb = (res + 7) / 8, off = 10;
        if (n < 3 * rb) return null;
        java.util.ArrayList<int[]> out = new java.util.ArrayList<>();
        int[] ref = new int[3]; for (int c = 0; c < 3; c++) { ref[c] = signed(v, off, rb); off += rb; }
        out.add(ref.clone());
        while (off + 2 <= v.length) {
            int width = v[off++] & 0xff, count = v[off++] & 0xff;
            int bits = width * count * 3, len = (bits + 7) / 8;
            if (width == 0 || off + len > v.length) break;
            int bit = 0;
            for (int k = 0; k < count; k++) {
                int[] last = out.get(out.size() - 1), nx = new int[3];
                for (int c = 0; c < 3; c++) {
                    int val = 0;
                    for (int j = 0; j < width; j++, bit++) if ((v[off + (bit >> 3)] & (1 << (bit & 7))) != 0) val |= 1 << j;
                    if ((val & (1 << (width - 1))) != 0) val |= -1 << width;
                    nx[c] = last[c] + val;
                }
                out.add(nx);
            }
            off += len;
        }
        return out.toArray(new int[0][]);
    }
    static int signed(byte[] v, int o, int sz) {
        int x = 0; for (int i = sz - 1; i >= 0; i--) x = (x << 8) | (v[o + i] & 0xff);
        int sh = 32 - 8 * sz; return (x << sh) >> sh;
    }

    /** Real-time step: |a| (mG) low-passed, minus slow baseline; peak above +300 mG, ≥ 250 ms apart. */
    private void step(int[] s) {
        double m = Math.sqrt((double) s[0] * s[0] + (double) s[1] * s[1] + (double) s[2] * s[2]);
        lp += 0.35 * (m - lp);
        base += 0.01 * (m - base);
        double d = lp - base;
        long idx = ++stepIdx;
        if (!above && d > 300) { above = true; peak = d; peakIdx = idx; }
        else if (above) {
            if (d > peak) { peak = d; peakIdx = idx; }
            if (d < 100) { above = false; if (peakIdx - lastPeakIdx >= FS / 4) { steps++; lastPeakIdx = peakIdx; } }
        }
    }

    synchronized void flush() { try { data.flush(); frames.flush(); } catch (IOException ignored) {} }
    synchronized void close(boolean complete) {
        try { data.flush(); frames.flush(); data.close(); frames.close(); } catch (IOException ignored) {}
        writeMeta(null, null, false, complete);
    }

    // ---- for the app: list / read chunks (deflated) / delete ----
    static JSONArray list(File root) {
        JSONArray a = new JSONArray();
        File[] ds = new File(root, DIR).listFiles();
        if (ds == null) return a;
        for (File d : ds) {
            try {
                File mf = new File(d, "meta.json"); if (!mf.exists()) continue;
                byte[] b = new byte[(int) mf.length()];
                try (FileInputStream in = new FileInputStream(mf)) { int r = in.read(b); }
                JSONObject o = new JSONObject(new String(b, StandardCharsets.UTF_8));
                o.put("bytes", new File(d, "data.bin").length());
                o.put("frames_bytes", new File(d, "frames.csv").length());
                a.put(o);
            } catch (Exception ignored) {}
        }
        return a;
    }
    static final String DONE_DIR = "acc-uploaded";
    static final long KEEP_MS = 7L * 24 * 3600 * 1000;

    /**
     * A numeric plugin argument as long. Capacitor's PluginCall.getLong() returns the default unless the JSON value is
     * a java.lang.Long — a JS number that fits in int arrives as Integer, so v1.6 always read offset 0 (24.11 bug).
     */
    static long argLong(Object v, long def) {
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof String) try { return Long.parseLong(((String) v).trim()); } catch (NumberFormatException e) { return def; }
        return def;
    }

    static File file(File root, String id, String file) {
        return new File(new File(new File(root, DIR), id), "frames".equals(file) ? "frames.csv" : "data.bin");
    }
    /** Raw slice [offset, offset+len) of data.bin / frames.csv (empty past the end). */
    static byte[] slice(File root, String id, String file, long offset, int len) throws IOException {
        File f = file(root, id, file);
        long size = f.length(); if (offset >= size || offset < 0) return new byte[0];
        int n = (int) Math.min(len, size - offset);
        byte[] b = new byte[n];
        try (java.io.RandomAccessFile r = new java.io.RandomAccessFile(f, "r")) { r.seek(offset); r.readFully(b); }
        return b;
    }
    static long crc32(byte[] b) { java.util.zip.CRC32 c = new java.util.zip.CRC32(); c.update(b); return c.getValue(); }
    static String sha256(File f) throws Exception {
        java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
        if (f.exists()) try (FileInputStream in = new FileInputStream(f)) { byte[] buf = new byte[64 * 1024]; int k; while ((k = in.read(buf)) > 0) md.update(buf, 0, k); }
        StringBuilder sb = new StringBuilder(); for (byte x : md.digest()) sb.append(String.format("%02x", x & 0xff)); return sb.toString();
    }
    /** zlib-deflated bytes of a slice. */
    static byte[] deflate(byte[] b) {
        int n = b.length;
        java.util.zip.Deflater def = new java.util.zip.Deflater(6);
        def.setInput(b); def.finish();
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(n / 2 + 64);
        byte[] buf = new byte[32 * 1024];
        while (!def.finished()) { int k = def.deflate(buf); bo.write(buf, 0, k); }
        def.end();
        return bo.toByteArray();
    }
    /** Uploaded and verified by the server: keep the copy KEEP_MS in acc-uploaded/ (just in case), then purge. */
    static boolean markUploaded(File root, String id) {
        File d = new File(new File(root, DIR), id);
        File done = new File(root, DONE_DIR); done.mkdirs();
        File to = new File(done, id);
        if (to.exists()) deleteDir(to);
        boolean ok = d.renameTo(to);
        if (ok) to.setLastModified(System.currentTimeMillis());
        purge(root, System.currentTimeMillis());
        return ok;
    }
    static int purge(File root, long now) {
        File[] ds = new File(root, DONE_DIR).listFiles(); int k = 0;
        if (ds != null) for (File d : ds) if (now - d.lastModified() > KEEP_MS) { deleteDir(d); k++; }
        return k;
    }
    static boolean delete(File root, String id) { return deleteDir(new File(new File(root, DIR), id)); }
    static boolean deleteDir(File d) {
        File[] fs = d.listFiles();
        if (fs != null) for (File f : fs) f.delete();
        return d.delete();
    }
}
