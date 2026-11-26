package tech.agantay.fitness;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class MiScaleTest {
    static byte[] hex(String s) {
        s = s.replace(" ", "");
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    // ctrl 02 26 = kg, impedance present, stabilized; 2026-11-26 08:15:30; 500 Ω; 16000/200 = 80.00 kg
    static final String FINAL_KG = "02 26 EA07 0B 1A 08 0F 1E F401 803E";

    @Test public void stabilizedKgWithImpedance() {
        MiScale.Reading r = MiScale.parse(hex(FINAL_KG));
        assertNotNull(r);
        assertEquals(80.0, r.weightKg, 1e-9);
        assertEquals(500, r.impedance);
        assertTrue(r.stable && r.hasImpedance && !r.removed && r.isFinal());
        assertEquals("kg", r.unit);
        assertEquals("2026-11-26T08:15:30", r.scaleTime());
        assertEquals("mi-20261126T081530-16000-kg", r.key());
    }

    @Test public void liveFrameIsNotFinal() {
        MiScale.Reading r = MiScale.parse(hex("02 04 EA07 0B 1A 08 0F 1E 0000 DC3D"));   // 15836/200 = 79.18 kg, still settling
        assertNotNull(r);
        assertFalse(r.isFinal());
        assertEquals(79.18, r.weightKg, 1e-9);
        assertEquals(0, r.impedance);
    }

    @Test public void loadRemovedIsNotFinal() {
        MiScale.Reading r = MiScale.parse(hex("02 A6 EA07 0B 1A 08 0F 1E F401 803E"));
        assertNotNull(r);
        assertTrue(r.removed);
        assertFalse(r.isFinal());
    }

    @Test public void stabilizedWithoutImpedance() {
        MiScale.Reading r = MiScale.parse(hex("02 24 EA07 0B 1A 08 0F 1E 0000 803E"));
        assertTrue(r.isFinal());
        assertEquals(0, r.impedance);
        // same timestamp + weight → the same key as the frame with impedance: one weighing, not two
        assertEquals(MiScale.parse(hex(FINAL_KG)).key(), r.key());
    }

    @Test public void impedanceOutOfRangeIsDropped() {
        assertEquals(0, MiScale.parse(hex("02 26 EA07 0B 1A 08 0F 1E D00F 803E")).impedance);   // 4048 Ω
    }

    @Test public void poundsAndJin() {
        MiScale.Reading lb = MiScale.parse(hex("03 24 EA07 0B 1A 08 0F 1E 0000 E544"));   // 17637 → 176.37 lb
        assertEquals("lb", lb.unit);
        assertEquals(80.0, lb.weightKg, 0.01);
        MiScale.Reading jin = MiScale.parse(hex("02 64 EA07 0B 1A 08 0F 1E 0000 803E"));  // 16000 → 160.00 jin
        assertEquals("jin", jin.unit);
        assertEquals(80.0, jin.weightKg, 1e-9);
    }

    @Test public void garbageIsRejected() {
        assertNull(MiScale.parse(null));
        assertNull(MiScale.parse(hex("02 26 EA07 0B")));
        assertNull(MiScale.parse(hex("02 26 EA07 0D 1A 08 0F 1E F401 803E")));   // month 13
    }

    @Test public void storeMergesRepeatsAndFillsImpedance() throws Exception {
        JSONArray a = new JSONArray();
        JSONObject noImp = ScaleStore.toJson(MiScale.parse(hex("02 24 EA07 0B 1A 08 0F 1E 0000 803E")), 1000L, "AA:BB");
        JSONObject imp = ScaleStore.toJson(MiScale.parse(hex(FINAL_KG)), 4000L, "AA:BB");
        assertTrue(ScaleStore.merge(a, noImp));
        assertFalse(ScaleStore.merge(a, noImp));        // the scale repeats the frame
        assertTrue(ScaleStore.merge(a, imp));           // second burst carries the impedance
        assertEquals(1, a.length());
        assertEquals(500, a.getJSONObject(0).getInt("impedance"));
        assertEquals(1000L, a.getJSONObject(0).getLong("t"));
        assertFalse(ScaleStore.merge(a, imp));
    }
}
