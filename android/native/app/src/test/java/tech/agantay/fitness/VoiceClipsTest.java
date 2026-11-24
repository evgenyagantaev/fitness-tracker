package tech.agantay.fitness;

import static org.junit.Assert.*;
import org.junit.Test;
import java.util.*;

public class VoiceClipsTest {
    private static void checkResolved(String phrase) {
        List<String> seq = VoiceClips.resolve(phrase);
        assertNotNull("unresolved: " + phrase, seq);
        assertFalse("empty: " + phrase, seq.isEmpty());
        for (String tok : seq) {
            if (!VoiceClips.GAP.equals(tok) && !VoiceClips.XFADE.equals(tok)) {
                assertTrue("unknown clip key " + tok + " for: " + phrase, VoiceClips.inventoryKeys().contains(tok));
            }
        }
    }

    @Test public void eventsAndHrThresholdsResolve() {
        checkResolved(RunPhrases.started());
        checkResolved(RunPhrases.paused());
        checkResolved(RunPhrases.resumed());
        checkResolved(RunPhrases.ended());
        checkResolved(RunPhrases.test());
        assertEquals(Collections.singletonList("ev.test"), VoiceClips.resolve(RunPhrases.test()));
        for (int b = 100; b <= 220; b += 20) checkResolved(RunPhrases.hrOver(b));
    }

    @Test public void milestonesResolve() {
        for (int m = 500; m <= 43000; m += 500) checkResolved(RunPhrases.distance(m));
    }

    @Test public void summariesResolveAcrossFullRange() {
        for (int b = 40; b <= 220; b++) checkResolved(RunPhrases.summary(b, 0, 0));
        for (int c = 60; c <= 240; c++) checkResolved(RunPhrases.summary(0, c, 0));
        for (int p = 120; p <= 1559; p++) checkResolved(RunPhrases.summary(0, 0, p));
        List<String> full = VoiceClips.resolve(RunPhrases.summary(132, 157, 403));
        assertEquals(Arrays.asList("curhr.132", VoiceClips.GAP, "curcad.157", VoiceClips.GAP, "paceA.6", VoiceClips.XFADE, "paceB.43"), full);
        assertEquals(Arrays.asList("pace.6.0"), VoiceClips.resolve(RunPhrases.summary(0, 0, 360)));
    }

    @Test public void finishSummariesResolveAcrossRange() {
        checkResolved(RunPhrases.finish(0, 0, 0, 0));
        checkResolved(RunPhrases.finish(60, 22, 0, 0));
        checkResolved(RunPhrases.finish(1500, 3600, 240, 155));
        checkResolved(RunPhrases.finish(21097, 6320, 300, 162));
        checkResolved(RunPhrases.finish(42195, 14400, 341, 148));
        for (int d = 50; d <= 43000; d += 137) checkResolved(RunPhrases.finish(d, 0, 0, 0));
        for (int s = 5; s <= 18000; s += 29) checkResolved(RunPhrases.finish(0, s, 0, 0));
        // 1500 m reuses dist.1500
        List<String> f = VoiceClips.resolve(RunPhrases.finish(1500, 420, 280, 150));
        assertTrue(f.contains("dist.1500"));
        assertTrue(f.contains("fin.time.m7"));
        assertTrue(f.contains("fin.paceA.4"));
        assertTrue(f.contains("paceB.40"));
        assertTrue(f.contains("fin.hr.150"));
    }

    @Test public void outOfRangeReturnsNullForTtsFallback() {
        assertNull(VoiceClips.resolve("Неизвестная фраза."));
        assertNull(VoiceClips.resolve(RunPhrases.summary(30, 0, 0)));
        assertNull(VoiceClips.resolve(RunPhrases.distance(50000)));
        assertNull(VoiceClips.resolve(""));
    }
}
