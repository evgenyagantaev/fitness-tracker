package tech.agantay.fitness;

import java.util.List;

/**
 * Pure-Java PCM assembly and radio hiss-bed mixing matching android/voice-gen/radio_fx.py (variant B).
 * Joins split phrases (e.g. paceA + paceB) with a 12 ms cosine crossfade, separates sentences by 420 ms,
 * and applies the continuous band-limited hiss bed across the whole transmission so there are zero seams or drops.
 */
final class VoicePcm {
    private VoicePcm() {}

    static final int LEAD_MS = 25, TRAIL_MS = 35, GAP_MS = 420, XFADE_MS = 12;
    static final float HISS_BASE = 0.45f, HISS_ENV = 0.55f, LIMITER = 0.88f;

    static short[] assemble(List<float[]> clips, List<String> tokens, float[] hissBed, int sr) {
        int lead = sr * LEAD_MS / 1000;
        int trail = sr * TRAIL_MS / 1000;
        int gap = sr * GAP_MS / 1000;
        int xf = sr * XFADE_MS / 1000;

        int total = lead + trail;
        int ci = 0;
        boolean nextXf = false;
        for (String tok : tokens) {
            if (VoiceClips.GAP.equals(tok)) {
                total += gap;
                nextXf = false;
            } else if (VoiceClips.XFADE.equals(tok)) {
                nextXf = true;
            } else {
                float[] c = clips.get(ci++);
                if (nextXf && c.length > xf && total > xf) total += c.length - xf;
                else total += c.length;
                nextXf = false;
            }
        }

        float[] buf = new float[total];
        int pos = lead;
        ci = 0;
        nextXf = false;
        for (String tok : tokens) {
            if (VoiceClips.GAP.equals(tok)) {
                pos += gap;
                nextXf = false;
            } else if (VoiceClips.XFADE.equals(tok)) {
                nextXf = true;
            } else {
                float[] c = clips.get(ci++);
                if (nextXf && c.length > xf && pos > xf) {
                    int start = pos - xf;
                    for (int i = 0; i < xf; i++) {
                        double t = (Math.PI / 2.0) * i / Math.max(1, xf - 1);
                        buf[start + i] = buf[start + i] * (float) Math.cos(t) + c[i] * (float) Math.sin(t);
                    }
                    System.arraycopy(c, xf, buf, pos, c.length - xf);
                    pos += c.length - xf;
                } else {
                    System.arraycopy(c, 0, buf, pos, c.length);
                    pos += c.length;
                }
                nextXf = false;
            }
        }

        if (hissBed != null && hissBed.length > 0) {
            float[] env = new float[total];
            float atk = (float) (1.0 - Math.exp(-1.0 / (sr * 0.008)));
            float rel = (float) (1.0 - Math.exp(-1.0 / (sr * 0.080)));
            float acc = 0f, maxE = 0f;
            for (int i = 0; i < total; i++) {
                float a = Math.abs(buf[i]);
                acc += (a > acc ? atk : rel) * (a - acc);
                env[i] = acc;
                if (acc > maxE) maxE = acc;
            }
            float invE = maxE > 1e-6f ? 1f / maxE : 0f;
            int fi = Math.max(1, lead), fo = Math.max(1, trail);
            for (int i = 0; i < total; i++) {
                float outer = 1f;
                if (i < fi) outer = (float) i / fi;
                else if (i >= total - fo) outer = (float) (total - 1 - i) / fo;
                float g = HISS_BASE + HISS_ENV * (env[i] * invE);
                buf[i] += hissBed[i % hissBed.length] * g * outer;
            }
        }

        float peak = 0f;
        for (float v : buf) { float a = Math.abs(v); if (a > peak) peak = a; }
        float scale = peak > LIMITER ? LIMITER / peak : 1f;

        short[] out = new short[total];
        for (int i = 0; i < total; i++) {
            int s = Math.round(buf[i] * scale * 32767f);
            out[i] = (short) (s > 32767 ? 32767 : Math.max(-32768, s));
        }
        return out;
    }
}
