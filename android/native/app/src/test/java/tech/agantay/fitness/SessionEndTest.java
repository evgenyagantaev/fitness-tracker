package tech.agantay.fitness;

import static org.junit.Assert.*;
import org.junit.Test;

/** Strap taken off (disconnect, or connected but no contact / HR 0) must end the HR session by itself. */
public class SessionEndTest {
    static final long T0 = 1_800_000_000_000L, MIN = 60_000L;

    @Test public void postRunEndsThreeMinutesAfterLastValidBeat() {
        long end = T0 + 30 * MIN, last = end + 20 * MIN;
        assertNull(WorkoutService.endReason("post", last + 2 * MIN, T0, end, last, 90, true));
        assertEquals("strap-off", WorkoutService.endReason("post", last + 3 * MIN + 1000, T0, end, last, 90, true));
    }

    @Test public void reconnectAttemptsDoNotKeepItAlive() {
        // disconnected strap: lastHrAt never moves, no matter how often we try to reconnect
        long end = T0 + 30 * MIN, last = end + 5 * MIN;
        String r = null;
        for (long now = last; now < last + 10 * MIN && r == null; now += 1000) r = WorkoutService.endReason("post", now, T0, end, last, 90, true);
        assertEquals("strap-off", r);
    }

    @Test public void postWindowAndPreTimeouts() {
        long end = T0 + 30 * MIN;
        assertEquals("post-done", WorkoutService.endReason("post", end + 90 * MIN + 1, T0, end, end + 90 * MIN, 90, true));
        assertEquals("no-hr", WorkoutService.endReason("pre", T0 + 11 * MIN, T0, 0, T0, 90, true));
        assertNull(WorkoutService.endReason("workout", T0 + 5 * 60 * MIN, T0, 0, T0, 90, true));   // never during a run
        assertEquals("pre-timeout", WorkoutService.endReason("pre", T0 + 121 * MIN, T0, 0, T0 + 120 * MIN, 90, true));
    }

    @Test public void contactBitAndZeroHrAreNotBeats() {
        assertTrue(WorkoutService.validBeat(0x00, 72));          // strap without contact info
        assertTrue(WorkoutService.validBeat(0x06, 72));          // contact supported + detected (H10 normal)
        assertFalse(WorkoutService.validBeat(0x04, 72));         // supported, NOT detected (strap off, still connected)
        assertFalse(WorkoutService.validBeat(0x06, 0));          // HR 0
        assertFalse(WorkoutService.validBeat(0x16, 300));
    }

    @Test public void beatTimesAreMonotonic() {
        java.util.List<Integer> a = java.util.Arrays.asList(800, 810);
        long[] t1 = WorkoutService.beatTimes(a, 10_000, Long.MIN_VALUE);
        assertEquals(10_000, t1[1]); assertEquals(9_190, t1[0]);
        // next notification arrives early/late (BLE jitter): the chain continues exactly RR apart (no squeezing)
        long[] t2 = WorkoutService.beatTimes(java.util.Arrays.asList(805, 800), 10_900, t1[1]);
        assertEquals(10_805, t2[0]); assertEquals(11_605, t2[1]);
        long[] t3 = WorkoutService.beatTimes(java.util.Arrays.asList(810), 13_400, t2[1]);
        assertEquals(12_415, t3[0]);
    }

    @Test public void beatChainRealignsOnlyOnDriftOverTwoSeconds() {
        // 5 s of notifications lost: chain would end at 10 800, notification at 16 000 → re-align to now
        long[] t = WorkoutService.beatTimes(java.util.Arrays.asList(800, 800), 16_000, 9_200);
        assertEquals(16_000, t[1]); assertEquals(15_200, t[0]);
        // re-aligned chain never goes back before the previous beat
        long[] u = WorkoutService.beatTimes(java.util.Arrays.asList(800, 800, 800), 1_000, 900);
        assertTrue(u[0] > 900 && u[1] > u[0] && u[2] > u[1]);
        // simulated 10 min at 75 bpm with ±150 ms notification jitter: beats stay exactly RR apart
        java.util.Random rnd = new java.util.Random(1); long prev = Long.MIN_VALUE, real = 0; int squeezed = 0, n = 0;
        for (int k = 0; k < 750; k++) {
            real += 800; long now = real + 20 + rnd.nextInt(300) - 150;
            long[] ts = WorkoutService.beatTimes(java.util.Arrays.asList(800), now, prev);
            if (prev != Long.MIN_VALUE) { n++; if (ts[0] - prev < 400) squeezed++; }
            prev = ts[0];
        }
        assertEquals(0, squeezed);
    }

    @Test public void tailCutFindsArtefactClusterOrTwentySeconds() {
        java.util.List<int[]> rr = new java.util.ArrayList<>();
        long t = 0; for (int i = 0; i < 300; i++) { t += 700; rr.add(new int[] { (int) t, 700 }); }
        long clean = t;
        assertEquals(clean - 20_000, WorkoutService.tailCutRel(rr, clean));   // clean tail: 20 s
        for (int v : new int[] { 2833, 1752, 2498, 940, 2350, 2641, 4018 }) { t += v; rr.add(new int[] { (int) t, v }); }
        long cut = WorkoutService.tailCutRel(rr, t);
        assertTrue("cut before the artefacts: " + cut + " vs " + clean, cut <= clean);
    }
}
