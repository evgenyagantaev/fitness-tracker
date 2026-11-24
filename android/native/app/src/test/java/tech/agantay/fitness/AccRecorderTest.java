package tech.agantay.fitness;

import static org.junit.Assert.*;

import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.file.Files;

public class AccRecorderTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    /** real H10 frame header seen on the device: 02 <ts 8 bytes> 01 then int16 x,y,z */
    static byte[] frame(long tsNs, int[][] xyz) {
        byte[] v = new byte[10 + xyz.length * 6];
        v[0] = 0x02;
        for (int i = 0; i < 8; i++) v[1 + i] = (byte) ((tsNs >> (8 * i)) & 0xff);
        v[9] = 0x01;
        for (int i = 0; i < xyz.length; i++) for (int c = 0; c < 3; c++) {
            int x = xyz[i][c]; v[10 + 6 * i + 2 * c] = (byte) (x & 0xff); v[11 + 6 * i + 2 * c] = (byte) ((x >> 8) & 0xff);
        }
        return v;
    }

    @Test public void parsesRealFrame() {
        // from the 24.11 test: 41 fd 7b ff c8 02 → x=-703, y=-133, z=712 mG
        byte[] v = { 0x02, (byte) 0xf2, (byte) 0xea, 0x71, 0x10, (byte) 0xea, 0x43, 0x52, 0x08, 0x01, 0x41, (byte) 0xfd, 0x7b, (byte) 0xff, (byte) 0xc8, 0x02 };
        int[][] s = AccRecorder.parse(v, v[9] & 0xff);
        assertEquals(1, s.length);
        assertArrayEquals(new int[] { -703, -133, 712 }, s[0]);
    }

    @Test public void argLongAcceptsIntegerFromJs() throws Exception {
        org.json.JSONObject d = new org.json.JSONObject("{\"offset\":524288,\"big\":5000000000,\"s\":\"12\",\"f\":1048576.0}");
        assertTrue(d.opt("offset") instanceof Integer);   // what broke v1.6: getLong() ignores Integer
        assertEquals(524288L, AccRecorder.argLong(d.opt("offset"), 0));
        assertEquals(5000000000L, AccRecorder.argLong(d.opt("big"), 0));
        assertEquals(12L, AccRecorder.argLong(d.opt("s"), 0));
        assertEquals(1048576L, AccRecorder.argLong(d.opt("f"), 0));
        assertEquals(-1L, AccRecorder.argLong(d.opt("none"), -1));
    }

    @Test public void slicesAreAtTheirOffsetAndUploadedCopiesKeptSevenDays() throws Exception {
        File root = tmp.getRoot();
        File dir = new File(root, "acc/aslice"); dir.mkdirs();
        byte[] all = new byte[1_200_000]; for (int i = 0; i < all.length; i++) all[i] = (byte) (i * 31 + (i >> 9));
        Files.write(new File(dir, "data.bin").toPath(), all);
        java.io.ByteArrayOutputStream joined = new java.io.ByteArrayOutputStream();
        for (long off = 0; off < all.length; off += 524288) {
            byte[] s = AccRecorder.slice(root, "aslice", "data", off, 524288);
            java.util.zip.Inflater inf = new java.util.zip.Inflater(); inf.setInput(AccRecorder.deflate(s));
            byte[] out = new byte[s.length]; int k = inf.inflate(out); inf.end();
            assertEquals(s.length, k);
            joined.write(out);
        }
        assertArrayEquals(all, joined.toByteArray());
        assertEquals(0, AccRecorder.slice(root, "aslice", "data", all.length, 10).length);
        String sha = AccRecorder.sha256(new File(dir, "data.bin"));
        assertEquals(64, sha.length());
        assertTrue(AccRecorder.markUploaded(root, "aslice"));
        assertFalse(dir.exists());
        File kept = new File(root, "acc-uploaded/aslice/data.bin");
        assertTrue(kept.exists());
        assertEquals(0, AccRecorder.purge(root, System.currentTimeMillis() + 6L * 24 * 3600 * 1000));
        assertEquals(1, AccRecorder.purge(root, System.currentTimeMillis() + 8L * 24 * 3600 * 1000));
        assertFalse(kept.exists());
    }

    @Test public void testFlagKept() throws Exception {
        AccRecorder r = new AccRecorder(tmp.getRoot(), "tflag", 1000, "Polar H10", null, true);
        r.close(true);
        String meta = new String(Files.readAllBytes(new File(tmp.getRoot(), "acc/tflag/meta.json").toPath()));
        assertTrue(meta, meta.contains("\"test\":true"));
    }

    @Test public void writesFileAndCountsSteps() throws Exception {
        File root = tmp.getRoot();
        AccRecorder r = new AccRecorder(root, "atest", 1000, "Polar H10", "wtest", false);
        double fs = 200, T = 60.0 / 170, tc = 0.25, fmax = Math.PI * T / (2 * tc);
        int n = (int) (fs * 180), per = 36; long ts = 0;
        int[][] buf = new int[per][3]; int k = 0;
        for (int i = 0; i < n; i++) {
            double t = i / fs, ph = t % T;
            double vert = ph < tc ? fmax * Math.sin(Math.PI * ph / tc) : 0;
            buf[k++] = new int[] { (int) (-vert * 1000), 0, 0 };
            if (k == per) { ts += (long) (per / fs * 1e9); r.onFrame(frame(ts, buf), 1000 + ts / 1_000_000); k = 0; buf = new int[per][3]; }
        }
        r.close(true);
        long expectSamples = (n / per) * per;
        assertEquals(expectSamples, r.samples);
        assertEquals(expectSamples * 6, new File(root, "acc/atest/data.bin").length());
        assertEquals(n / per, Files.readAllLines(new File(root, "acc/atest/frames.csv").toPath()).size());
        int expectSteps = (int) (expectSamples / fs / T);
        assertTrue("steps " + r.steps + " vs " + expectSteps, Math.abs(r.steps - expectSteps) <= 3);
        String meta = new String(Files.readAllBytes(new File(root, "acc/atest/meta.json").toPath()));
        assertTrue(meta.contains("\"complete\":true"));
        assertTrue(meta.contains("\"workout_id\":\"wtest\""));
        // resume after a crash mid-write: partial sample and partial frame line are dropped
        try (java.io.FileOutputStream o = new java.io.FileOutputStream(new File(root, "acc/atest/data.bin"), true)) { o.write(new byte[] { 1, 2, 3, 4 }); }
        try (java.io.FileOutputStream o = new java.io.FileOutputStream(new File(root, "acc/atest/frames.csv"), true)) { o.write("99999,123".getBytes()); }
        AccRecorder r2 = new AccRecorder(root, "atest", 1000, null, null, false);
        assertEquals(expectSamples, r2.samples);
        assertEquals(expectSamples * 6, new File(root, "acc/atest/data.bin").length());
        assertEquals(n / per, Files.readAllLines(new File(root, "acc/atest/frames.csv").toPath()).size());
    }
}
