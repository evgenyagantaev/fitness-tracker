package tech.agantay.fitness;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Decodes bundled Opus (.ogg) speech fragments from assets/voice/, stitches them via VoicePcm
 * with the continuous radio hiss bed (variant B), and plays them through AudioTrack on the guidance stream.
 */
final class ClipPlayer {
    private static final String TAG = "ClipPlayer";
    private static final String DIR = "voice";
    private static final int DEFAULT_SR = 48000;

    private final AssetManager assets;
    private final Set<String> available;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private float[] hissBed;
    private boolean hissLoaded = false;

    ClipPlayer(Context ctx) {
        this.assets = ctx.getAssets();
        Set<String> s = new HashSet<>();
        try {
            String[] list = assets.list(DIR);
            if (list != null) Collections.addAll(s, list);
        } catch (Exception e) {
            Log.w(TAG, "assets list", e);
        }
        this.available = Collections.unmodifiableSet(s);
    }

    boolean hasClips() { return available.contains("ev.start.ogg"); }

    boolean canPlay(List<String> tokens) {
        if (tokens == null || tokens.isEmpty() || !hasClips()) return false;
        for (String tok : tokens) {
            if (!VoiceClips.GAP.equals(tok) && !VoiceClips.XFADE.equals(tok) && !available.contains(tok + ".ogg")) {
                return false;
            }
        }
        return true;
    }

    void playAsync(List<String> tokens, AudioAttributes attrs, Runnable onDone, Runnable onFail) {
        exec.execute(() -> {
            AudioTrack track = null;
            try {
                if (!hissLoaded) {
                    hissLoaded = true;
                    if (available.contains("hiss_bed.ogg")) {
                        Decoded h = decodeOgg("hiss_bed.ogg");
                        hissBed = h != null ? h.samples : null;
                    }
                }
                List<float[]> clips = new ArrayList<>();
                int sr = DEFAULT_SR;
                for (String tok : tokens) {
                    if (VoiceClips.GAP.equals(tok) || VoiceClips.XFADE.equals(tok)) continue;
                    Decoded d = decodeOgg(tok + ".ogg");
                    if (d == null || d.samples.length == 0) throw new IllegalStateException("decode failed: " + tok);
                    sr = d.sampleRate;
                    clips.add(d.samples);
                }
                short[] pcm = VoicePcm.assemble(clips, tokens, hissBed, sr);

                int minBuf = AudioTrack.getMinBufferSize(sr, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
                int bufBytes = Math.max(minBuf * 4, 16384);
                track = new AudioTrack.Builder()
                    .setAudioAttributes(attrs)
                    .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sr)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build())
                    .setBufferSizeInBytes(bufBytes)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();

                track.play();
                int off = 0;
                while (off < pcm.length) {
                    int n = Math.min(4096, pcm.length - off);
                    int w = track.write(pcm, off, n, AudioTrack.WRITE_BLOCKING);
                    if (w <= 0) break;
                    off += w;
                }
                short[] pad = new short[Math.min(4096, Math.max(1024, minBuf / 2))];
                track.write(pad, 0, pad.length, AudioTrack.WRITE_BLOCKING);

                long deadline = System.currentTimeMillis() + (pcm.length * 1000L / sr) + 1500L;
                while (track.getPlaybackHeadPosition() < pcm.length && System.currentTimeMillis() < deadline) {
                    Thread.sleep(35);
                }
                track.stop();
                onDone.run();
            } catch (Throwable t) {
                Log.w(TAG, "clip play error, falling back to TTS", t);
                onFail.run();
            } finally {
                if (track != null) {
                    try { track.release(); } catch (Exception ignored) {}
                }
            }
        });
    }

    private static final class Decoded {
        final float[] samples;
        final int sampleRate;
        Decoded(float[] samples, int sampleRate) { this.samples = samples; this.sampleRate = sampleRate; }
    }

    private Decoded decodeOgg(String filename) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        MediaCodec codec = null;
        try (AssetFileDescriptor afd = assets.openFd(DIR + "/" + filename)) {
            ex.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            if (ex.getTrackCount() == 0) return null;
            MediaFormat fmt = ex.getTrackFormat(0);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            if (mime == null) return null;
            ex.selectTrack(0);

            int sr = fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) : DEFAULT_SR;
            int ch = fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 1;

            codec = MediaCodec.createDecoderByType(mime);
            codec.configure(fmt, null, null, 0);
            codec.start();

            ByteArrayOutputStream pcmBytes = new ByteArrayOutputStream(32768);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inDone = false, outDone = false;
            byte[] tmp = new byte[8192];

            while (!outDone) {
                if (!inDone) {
                    int inIdx = codec.dequeueInputBuffer(10_000);
                    if (inIdx >= 0) {
                        ByteBuffer inBuf = codec.getInputBuffer(inIdx);
                        int sampleSize = ex.readSampleData(inBuf, 0);
                        if (sampleSize < 0) {
                            codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            codec.queueInputBuffer(inIdx, 0, sampleSize, Math.max(0, ex.getSampleTime()), 0);
                            ex.advance();
                        }
                    }
                }
                int outIdx = codec.dequeueOutputBuffer(info, 10_000);
                if (outIdx >= 0) {
                    if (info.size > 0) {
                        ByteBuffer outBuf = codec.getOutputBuffer(outIdx);
                        outBuf.position(info.offset);
                        outBuf.limit(info.offset + info.size);
                        int rem = info.size;
                        while (rem > 0) {
                            int n = Math.min(rem, tmp.length);
                            outBuf.get(tmp, 0, n);
                            pcmBytes.write(tmp, 0, n);
                            rem -= n;
                        }
                    }
                    codec.releaseOutputBuffer(outIdx, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                } else if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    if (of.containsKey(MediaFormat.KEY_SAMPLE_RATE)) sr = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    if (of.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) ch = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                }
            }

            byte[] raw = pcmBytes.toByteArray();
            int nFrames = raw.length / (2 * Math.max(1, ch));
            float[] samples = new float[nFrames];
            ByteBuffer bb = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i < nFrames; i++) {
                float sum = 0f;
                for (int c = 0; c < ch; c++) sum += bb.getShort() / 32768f;
                samples[i] = sum / ch;
            }
            return new Decoded(samples, sr);
        } finally {
            if (codec != null) {
                try { codec.stop(); } catch (Exception ignored) {}
                try { codec.release(); } catch (Exception ignored) {}
            }
            try { ex.release(); } catch (Exception ignored) {}
        }
    }
}
