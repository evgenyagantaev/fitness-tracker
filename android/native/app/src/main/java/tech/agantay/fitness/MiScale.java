package tech.agantay.fitness;

import java.util.Locale;

/**
 * Xiaomi Mi Body Composition Scale 2 (XMTZC05HM) advertisement: Body Composition service data (UUID 0x181B), 13 bytes,
 * broadcast without pairing while someone stands on the scale:
 * <pre>
 *  [0]  control 0: bit0 = pounds
 *  [1]  control 1: bit1 = impedance present, bit5 = stabilized, bit6 = jin (catty), bit7 = load removed
 *  [2-3] year LE, [4] month, [5] day, [6] hour, [7] minute, [8] second   (scale clock)
 *  [9-10] impedance LE, Ω
 *  [11-12] weight LE: kg × 200, or lb / jin × 100
 * </pre>
 * The scale sends the same reading many times (and a second burst with the impedance), so a reading is keyed by its
 * scale timestamp + raw weight.
 */
final class MiScale {
    static final String SERVICE_UUID = "0000181b-0000-1000-8000-00805f9b34fb";

    static final class Reading {
        double weightKg;     // converted to kg whatever the unit on the display
        int impedance;       // 0 = none in this frame
        boolean stable, removed, hasImpedance;
        String unit;         // kg | lb | jin
        int rawWeight;
        int year, month, day, hour, minute, second;

        /** a final weighing: stabilized and the person still on the scale */
        boolean isFinal() { return stable && !removed && weightKg >= 5; }

        String scaleTime() {
            return String.format(Locale.ROOT, "%04d-%02d-%02dT%02d:%02d:%02d", year, month, day, hour, minute, second);
        }

        String key() {
            return String.format(Locale.ROOT, "mi-%04d%02d%02dT%02d%02d%02d-%d-%s", year, month, day, hour, minute, second, rawWeight, unit);
        }
    }

    private MiScale() {}

    /** @return null if the bytes are not a Mi Scale 2 body-composition frame */
    static Reading parse(byte[] d) {
        if (d == null || d.length < 13) return null;
        int c0 = d[0] & 0xFF, c1 = d[1] & 0xFF;
        Reading r = new Reading();
        boolean lb = (c0 & 0x01) != 0, jin = (c1 & 0x40) != 0;
        r.hasImpedance = (c1 & 0x02) != 0;
        r.stable = (c1 & 0x20) != 0;
        r.removed = (c1 & 0x80) != 0;
        r.year = (d[2] & 0xFF) | ((d[3] & 0xFF) << 8);
        r.month = d[4] & 0xFF; r.day = d[5] & 0xFF; r.hour = d[6] & 0xFF; r.minute = d[7] & 0xFF; r.second = d[8] & 0xFF;
        int imp = (d[9] & 0xFF) | ((d[10] & 0xFF) << 8);
        r.rawWeight = (d[11] & 0xFF) | ((d[12] & 0xFF) << 8);
        if (lb) { r.unit = "lb"; r.weightKg = r.rawWeight / 100.0 * 0.45359237; }
        else if (jin) { r.unit = "jin"; r.weightKg = r.rawWeight / 100.0 * 0.5; }
        else { r.unit = "kg"; r.weightKg = r.rawWeight / 200.0; }
        r.weightKg = Math.round(r.weightKg * 100) / 100.0;
        // the scale reports 0 or ≥ 3000 Ω when it could not measure (shoes, wet feet, stepped off too early)
        r.impedance = r.hasImpedance && imp > 0 && imp < 3000 ? imp : 0;
        if (r.month < 1 || r.month > 12 || r.day < 1 || r.day > 31 || r.hour > 23 || r.minute > 59 || r.second > 59) return null;
        if (r.weightKg > 300) return null;
        return r;
    }
}
