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
}
