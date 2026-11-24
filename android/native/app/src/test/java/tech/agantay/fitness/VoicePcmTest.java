package tech.agantay.fitness;

import static org.junit.Assert.*;
import org.junit.Test;
import java.util.*;

public class VoicePcmTest {
    @Test public void crossfadeAndGapProduceContinuousHissAndSmoothJoin() {
        int sr = 48000;
        // two sine clips joined via XFADE, then GAP, then a third clip
        float[] c1 = new float[sr / 2];
        float[] c2 = new float[sr / 2];
        float[] c3 = new float[sr / 4];
        for (int i = 0; i < c1.length; i++) c1[i] = (i > c1.length - sr / 20) ? 0f : 0.4f * (float) Math.sin(2 * Math.PI * 220 * i / sr);
        for (int i = 0; i < c2.length; i++) c2[i] = (i < sr / 20) ? 0f : 0.4f * (float) Math.sin(2 * Math.PI * 220 * i / sr);
        for (int i = 0; i < c3.length; i++) c3[i] = 0.4f * (float) Math.sin(2 * Math.PI * 330 * i / sr);

        float[] hiss = new float[sr];
        for (int i = 0; i < hiss.length; i++) hiss[i] = 0.03f * (float) Math.sin(2 * Math.PI * 1000 * i / sr);

        List<String> tokens = Arrays.asList("paceA.6", VoiceClips.XFADE, "paceB.43", VoiceClips.GAP, "curhr.132");
        short[] out = VoicePcm.assemble(Arrays.asList(c1, c2, c3), tokens, hiss, sr);

        int expectedSamples = (VoicePcm.LEAD_MS + VoicePcm.TRAIL_MS + VoicePcm.GAP_MS - VoicePcm.XFADE_MS) * (sr / 1000) + c1.length + c2.length + c3.length;
        assertEquals(expectedSamples, out.length);

        // gap between c2 and c3 must NOT drop to dead zero: hiss bed remains present
        int gapStart = (VoicePcm.LEAD_MS - VoicePcm.XFADE_MS) * (sr / 1000) + c1.length + c2.length + sr / 10;
        double gapRms = 0;
        for (int i = gapStart; i < gapStart + sr / 5; i++) {
            double v = out[i] / 32768.0;
            gapRms += v * v;
        }
        gapRms = Math.sqrt(gapRms / (sr / 5));
        assertTrue("hiss bed must stay active across sentence gap: " + gapRms, gapRms > 0.005);

        // outer boundaries must taper smoothly
        assertTrue(Math.abs(out[0]) < 50);
        assertTrue(Math.abs(out[out.length - 1]) < 50);
    }
}
