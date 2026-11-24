package tech.agantay.fitness;

import static org.junit.Assert.*;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/** v1.7: forgotten «Стоп» detector and the phone-accelerometer recorder. */
public class RunEndTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    /** walk 60 s, run 600 s at 165 spm / 2.8 m/s, then stand still (or walk) until nowSec */
    static List<int[]> steps(int runFrom, int runTo, int nowSec, double idleCad) {
        List<int[]> ss = new ArrayList<>(); double st = 0;
        for (int t = 15; t <= nowSec; t += 10) {
            double cad = t < runFrom ? 100 : t <= runTo ? 165 : idleCad;
            st += cad / 6.0; ss.add(new int[] { t, (int) Math.round(st) });
        }
        return ss;
    }
    static List<double[]> track(int runFrom, int runTo, int nowSec, double idleSpeed) {
        List<double[]> tr = new ArrayList<>(); double lat = 55.0;
        for (int t = 0; t <= nowSec; t += 2) {
            double v = t < runFrom ? 1.3 : t <= runTo ? 2.8 : idleSpeed;
            lat += v * 2 / 111195.0; tr.add(new double[] { t, lat, 37.0, 5 });
        }
        return tr;
    }
    static List<int[]> hr(int runTo, int nowSec) {
        List<int[]> h = new ArrayList<>();
        for (int t = 0; t <= nowSec; t++) h.add(new int[] { t, t <= runTo ? 165 : (int) Math.max(85, 165 - (t - runTo) * 0.35) });
        return h;
    }

    @Test public void notRunningYetMeansNoVerdict() {
        RunEnd.Verdict v = RunEnd.verdict(steps(9999, 9999, 400, 100), track(9999, 9999, 400, 1.3), new ArrayList<>(), false, 400);
        assertFalse(v.ran); assertFalse(v.notify); assertFalse(v.close);
    }

    @Test public void runningWorkoutIsNotFlagged() {
        int now = 500;
        RunEnd.Verdict v = RunEnd.verdict(steps(60, 9999, now, 100), track(60, 9999, now, 1.3), new ArrayList<>(), false, now);
        assertTrue(v.ran); assertTrue(v.idleSec < 20); assertFalse(v.notify);
    }

    @Test public void beltlessForgottenStopNotifiesAt10AndClosesAt15Min() {
        int runTo = 660;
        int now = runTo + 11 * 60;
        RunEnd.Verdict v = RunEnd.verdict(steps(60, runTo, now, 0), track(60, runTo, now, 0), new ArrayList<>(), false, now);
        assertTrue(v.ran);
        assertTrue("last run second near the real end: " + v.lastRunSec, Math.abs(v.lastRunSec - runTo) <= 25);
        assertTrue(v.notify); assertFalse(v.close);
        now = runTo + 16 * 60;
        v = RunEnd.verdict(steps(60, runTo, now, 0), track(60, runTo, now, 0), new ArrayList<>(), false, now);
        assertTrue(v.close);
        now = runTo + 6 * 60;   // 6 min of standing around after a run — still the owner's decision
        v = RunEnd.verdict(steps(60, runTo, now, 0), track(60, runTo, now, 0), new ArrayList<>(), false, now);
        assertFalse(v.notify);
    }

    @Test public void walkingHomeIsNotRunning() {
        int runTo = 660, now = runTo + 12 * 60;
        // 105 spm walk at 1.4 m/s: not a run → still counts as idle
        RunEnd.Verdict v = RunEnd.verdict(steps(60, runTo, now, 105), track(60, runTo, now, 1.4), new ArrayList<>(), false, now);
        assertTrue(v.notify);
        assertTrue(Math.abs(v.lastRunSec - runTo) <= 25);
    }

    @Test public void withStrapTheHrDeclineSpeedsItUp() {
        int runTo = 660, now = runTo + 5 * 60;
        RunEnd.Verdict v = RunEnd.verdict(steps(60, runTo, now, 0), track(60, runTo, now, 0), hr(runTo, now), true, now);
        assertTrue("HR fell ~100 bpm → evidence", v.hrEvidence);
        assertTrue(v.notify); assertFalse(v.close);
        now = runTo + 13 * 60;
        v = RunEnd.verdict(steps(60, runTo, now, 0), track(60, runTo, now, 0), hr(runTo, now), true, now);
        assertTrue(v.close);
    }

    @Test public void withStrapButHrStillHighNoEarlyNotification() {
        int runTo = 660, now = runTo + 5 * 60;
        List<int[]> h = new ArrayList<>(); for (int t = 0; t <= now; t++) h.add(new int[] { t, 160 });   // stopped for a dog/traffic, HR high
        RunEnd.Verdict v = RunEnd.verdict(steps(60, runTo, now, 0), track(60, runTo, now, 0), h, true, now);
        assertFalse(v.hrEvidence); assertFalse(v.notify); assertFalse(v.close);
    }

    @Test public void lostStrapFallsBackToBeltlessThresholds() {
        int runTo = 660, now = runTo + 11 * 60;
        List<int[]> h = hr(runTo, runTo + 60);   // the strap stopped talking a minute after the run
        RunEnd.Verdict v = RunEnd.verdict(steps(60, runTo, now, 0), track(60, runTo, now, 0), h, true, now);
        assertTrue(v.notify);
    }

    @Test public void dogStopsInsideTheRunDoNotEndIt() {
        // run, 40-s dog stop, run again: the last run second is the end of the second part
        List<int[]> ss = new ArrayList<>(); double st = 0;
        for (int t = 15; t <= 900; t += 10) { double c = (t >= 300 && t < 340) ? 0 : t < 60 ? 100 : t <= 600 ? 165 : 0; st += c / 6.0; ss.add(new int[] { t, (int) Math.round(st) }); }
        List<double[]> tr = new ArrayList<>(); double lat = 55;
        for (int t = 0; t <= 900; t += 2) { double v = (t >= 300 && t < 340) ? 0 : t < 60 ? 1.3 : t <= 600 ? 2.8 : 0; lat += v * 2 / 111195.0; tr.add(new double[] { t, lat, 37, 5 }); }
        RunEnd.Verdict v = RunEnd.verdict(ss, tr, new ArrayList<>(), false, 900);
        assertTrue(Math.abs(v.lastRunSec - 600) <= 25);
    }

    @Test public void phoneAccelerometerFileIsInTheSameFormatAsH10() throws Exception {
        AccRecorder r = new AccRecorder(tmp.getRoot(), "aphone1", 1_700_000_000_000L, "phone", "w1", false);
        r.source = "phone"; r.fsNom = 50; r.writeMeta("phone", "w1", false, false);
        long ns = 5_000_000_000L; long wall = 1_700_000_100_000L;
        for (int i = 0; i < 125; i++) r.onPhoneSample(ns + i * 20_000_000L, 0.1f, -9.80665f, 4.9f, wall + i * 20L);
        r.flush();
        File d = new File(new File(tmp.getRoot(), "acc"), "aphone1");
        byte[] b = Files.readAllBytes(new File(d, "data.bin").toPath());
        assertEquals(125 * 6, b.length);
        int y = (short) ((b[2] & 0xff) | (b[3] << 8)), z = (short) ((b[4] & 0xff) | (b[5] << 8));
        assertEquals(-1000, y, 1); assertEquals(500, z, 1);
        List<String> fr = Files.readAllLines(new File(d, "frames.csv").toPath());
        assertEquals(2, fr.size());   // after 50 and 100 samples
        assertTrue(fr.get(0).startsWith("50,"));
        assertTrue(fr.get(1).startsWith("100,"));
        String meta = new String(Files.readAllBytes(new File(d, "meta.json").toPath()));
        assertTrue(meta.contains("\"source\":\"phone\"")); assertTrue(meta.contains("\"fs\":50"));
        // a resume after the process died keeps the phone settings
        r.close(false);
        AccRecorder r2 = new AccRecorder(tmp.getRoot(), "aphone1", 1_700_000_000_000L, "phone", "w1", false);
        assertEquals("phone", r2.source); assertEquals(50, r2.fsNom);
        assertEquals(125, r2.samples);
    }
}
