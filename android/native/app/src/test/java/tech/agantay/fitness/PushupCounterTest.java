package tech.agantay.fitness;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class PushupCounterTest {
    /** one push-up: down (near) for `down` ms, then up (far) */
    private static boolean rep(PushupCounter c, long t, long down) {
        c.onProximity(t, true);
        return c.onProximity(t + down, false);
    }

    @Test public void nearThenFarIsOneRep() {
        PushupCounter c = new PushupCounter(false, 0);
        assertFalse(c.onProximity(1000, true));          // chest down: not yet
        assertTrue(c.onProximity(1700, false));           // chest up: rep
        assertEquals(1, c.reps());
    }

    @Test public void steadyReps() {
        PushupCounter c = new PushupCounter(false, 0);
        for (int i = 0; i < 20; i++) assertTrue(rep(c, 1000 + i * 1500L, 700));
        assertEquals(20, c.reps());
        assertEquals(19 * 1.5, c.activeSeconds(), 1e-9);
    }

    @Test public void fastRepsStillCounted() {
        PushupCounter c = new PushupCounter(false, 0);
        for (int i = 0; i < 15; i++) assertTrue(rep(c, 1000 + i * 700L, 350));   // 0.7 s per rep
        assertEquals(15, c.reps());
    }

    @Test public void sensorFlickerIsNotARep() {
        PushupCounter c = new PushupCounter(false, 0);
        assertFalse(rep(c, 1000, 60));                   // 60 ms near: noise
        assertEquals(0, c.reps());
    }

    @Test public void debounceOfTheUpPhase() {
        PushupCounter c = new PushupCounter(false, 0);
        assertTrue(rep(c, 1000, 500));                   // up at 1500
        assertFalse(rep(c, 1600, 200));                  // up again at 1800: 300 ms after the last rep → bounce
        assertTrue(rep(c, 2000, 300));                   // up at 2300: 800 ms after → counts
        assertEquals(2, c.reps());
    }

    @Test public void coveredPhoneIsNotARep() {
        PushupCounter c = new PushupCounter(false, 0);
        c.onProximity(1000, true);
        assertFalse(c.onProximity(1000 + 16_000, false));   // a hand over the phone for 16 s
        assertEquals(0, c.reps());
        assertTrue(rep(c, 20_000, 800));                    // and counting goes on normally
    }

    @Test public void startedCoveredCountsOnlyAfterRelease() {
        PushupCounter c = new PushupCounter(true, 5000);     // sensor already near when the set started
        assertTrue(c.onProximity(5600, false));              // released after 0.6 s: a rep
        assertEquals(1, c.reps());
        PushupCounter d = new PushupCounter(true, 0);
        assertFalse(d.onProximity(20_000, false));           // phone was in a pocket
    }

    @Test public void repeatedSameStateIsIgnored() {
        PushupCounter c = new PushupCounter(false, 0);
        c.onProximity(1000, true); c.onProximity(1100, true); c.onProximity(1200, true);
        assertTrue(c.onProximity(1800, false));
        assertFalse(c.onProximity(1900, false));
        assertEquals(1, c.reps());
    }

    @Test public void undoDropsTheLastRep() {
        PushupCounter c = new PushupCounter(false, 0);
        for (int i = 0; i < 3; i++) rep(c, 1000 + i * 1500L, 600);
        assertTrue(c.undo());
        assertEquals(2, c.reps());
        assertEquals(1000 + 1500 + 600, c.lastRepMs());
        assertTrue(c.undo()); assertTrue(c.undo());
        assertFalse(c.undo());
        assertEquals(0, c.reps()); assertEquals(-1, c.lastRepMs());
    }

    @Test public void redmiBinaryProximitySensor() {
        // Redmi Note 8 Pro: values 0.0 (near) and 5.0 (far), max range 5.0
        assertTrue(PushupCounter.isNear(0f, 5f));
        assertFalse(PushupCounter.isNear(5f, 5f));
        // a continuous sensor (0–8 cm): near below 5 cm
        assertTrue(PushupCounter.isNear(3f, 8f)); assertFalse(PushupCounter.isNear(6f, 8f));
        // a 0/1 sensor
        assertTrue(PushupCounter.isNear(0f, 1f)); assertFalse(PushupCounter.isNear(1f, 1f));
    }

    @Test public void storeKeepsEachSetOnce() throws Exception {
        JSONArray a = new JSONArray();
        assertTrue(PushupStore.merge(a, new JSONObject().put("id", "pu-1-001").put("reps", 20)));
        assertFalse(PushupStore.merge(a, new JSONObject().put("id", "pu-1-001").put("reps", 20)));
        assertTrue(PushupStore.merge(a, new JSONObject().put("id", "pu-2-002").put("reps", 15)));
        assertEquals(2, a.length());
    }

    @Test public void everyRepHasAClipAndTheTextIsRussianNumeral() {
        assertTrue(VoiceClips.inventoryKeys().contains("cnt.1"));
        assertTrue(VoiceClips.inventoryKeys().contains("cnt." + VoiceClips.MAX_REP));
        assertEquals("двадцать один.", VoiceClips.inventory().get("cnt.21")[1].toLowerCase());
        assertEquals("cnt.15", VoiceClips.resolve("пятнадцать.").get(0));
    }

    @Test public void snapshotRoundTripKeepsRepsAndIdleAge() throws Exception {
        PushupCounter c = new PushupCounter(false, 0);
        assertTrue(rep(c, 10_000, 400));
        assertTrue(rep(c, 12_000, 400));
        assertTrue(rep(c, 14_000, 400));
        assertEquals(3, c.reps());
        long nowMono = 20_000, nowWall = 1_700_000_000_000L;
        JSONObject live = c.putSnapshot(new JSONObject().put("id", "pu-1").put("startedAt", nowWall - 10_000), nowWall, nowMono);
        assertEquals(3, live.getInt("reps"));
        assertEquals(nowWall - (nowMono - 14_400), live.getLong("lastRepWall")); // last far edge at 14400
        // same wall time, new elapsed clock (process death): last rep was 5600 ms ago
        PushupCounter d = PushupCounter.fromSnapshot(live, nowWall, 1_000);
        assertEquals(3, d.reps());
        assertEquals(1_000 - 5_600, d.lastRepMs());
        PushupCounter e = PushupCounter.fromSnapshot(live, nowWall + 6_000, 1_000);
        assertEquals(1_000 - 11_600, e.lastRepMs());   // 6 s later still
        assertEquals(3, new JSONArray(live.getJSONArray("repWalls").toString()).length());
    }

    @Test public void liveExpiresAfterTwoMinutesIdleAndNotBefore() throws Exception {
        JSONObject live = new JSONObject().put("reps", 7).put("startedAt", 1000).put("lastRepWall", 50_000);
        assertFalse(PushupLive.expired(live, 50_000 + 119_000));
        assertTrue(PushupLive.expired(live, 50_000 + 120_001));
        JSONObject empty = new JSONObject().put("reps", 0).put("startedAt", 1000);
        assertFalse(PushupLive.expired(empty, 1000 + 299_000));
        assertTrue(PushupLive.expired(empty, 1000 + 300_001));
        assertFalse(PushupLive.expired(null, 999999));
        JSONObject set = PushupLive.toSet(live, 50_000 + 130_000);
        assertEquals(7, set.getInt("reps"));
        assertEquals(1000, set.getLong("t"));
        assertNull(PushupLive.toSet(empty, 400_000));
    }
}
