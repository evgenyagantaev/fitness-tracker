package tech.agantay.fitness;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.util.Log;

import java.util.concurrent.ConcurrentHashMap;

/**
 * v1.10: says the number of every push-up as it is counted. Uses the same radio-voice clips as the run announcements (cnt.N), but not
 * the announcement queue: that one never interrupts and keeps ≥1.2 s between phrases, which is too slow for reps.
 *  - clips are decoded once and kept in memory, one AudioTrack stays open (low-latency mode), so a number starts within a few ms;
 *  - «latest wins»: if a new rep comes while the previous number is still being spoken, the old one is cut and the new one is said;
 *  - above MAX_REP (200) there are no clips → the normal TTS fallback.
 */
final class RepVoice {
    private static final String TAG = "RepVoice";
    private final Context app;
    private final ClipPlayer clips;
    private final ConcurrentHashMap<Integer, ClipPlayer.Pcm> cache = new ConcurrentHashMap<>();
    private final Object lock = new Object();
    private volatile int want = 0;
    private volatile boolean running = false;
    private Thread worker;
    private AudioTrack track;
    private int trackRate = 0;
    private AudioManager am;
    private AudioFocusRequest focusReq;
    private final AudioAttributes attrs = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();

    RepVoice(Context ctx) { app = ctx.getApplicationContext(); clips = new ClipPlayer(app); }

    boolean hasClips() { return clips.hasClips(); }

    /** start the worker, take audio focus (ducking), pre-decode the first numbers in the background */
    synchronized void start() {
        if (running) return;
        running = true;
        am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        requestFocus();
        worker = new Thread(this::loop, "rep-voice");
        worker.setPriority(Thread.MAX_PRIORITY - 1);
        worker.start();
        new Thread(() -> { for (int n = 1; n <= 40 && running; n++) pcm(n); }, "rep-voice-warm").start();
    }

    synchronized void stop() {
        running = false;
        synchronized (lock) { want = 0; lock.notifyAll(); }
        abandonFocus();
    }

    /** say this number now (cuts the previous one if it is still being spoken) */
    void say(int n) {
        if (n < 1) return;
        if (n > VoiceClips.MAX_REP || !clips.hasClips()) {
            VoiceSpeaker.get(app).sayNow(RuNum.words(n));
            return;
        }
        synchronized (lock) { want = n; lock.notifyAll(); }
    }

    private ClipPlayer.Pcm pcm(int n) {
        ClipPlayer.Pcm p = cache.get(n);
        if (p == null) {
            p = clips.decodePcm("cnt." + n);
            if (p != null) cache.put(n, p);
        }
        return p;
    }

    private void ensureTrack(int sr) {
        if (track != null && trackRate == sr) return;
        releaseTrack();
        int minBuf = AudioTrack.getMinBufferSize(sr, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioTrack.Builder b = new AudioTrack.Builder().setAudioAttributes(attrs)
            .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(sr).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(Math.max(minBuf, 4096)).setTransferMode(AudioTrack.MODE_STREAM);
        if (Build.VERSION.SDK_INT >= 26) b.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY);
        track = b.build();
        trackRate = sr;
        track.play();
    }

    private void releaseTrack() {
        if (track == null) return;
        try { track.stop(); } catch (Exception ignored) {}
        try { track.release(); } catch (Exception ignored) {}
        track = null; trackRate = 0;
    }

    private void loop() {
        try {
            while (running) {
                int n;
                synchronized (lock) {
                    while (want == 0 && running) lock.wait(500);
                    if (!running) break;
                    n = want; want = 0;
                }
                ClipPlayer.Pcm p = pcm(n);
                if (p == null) { VoiceSpeaker.get(app).sayNow(RuNum.words(n)); continue; }
                try {
                    ensureTrack(p.sampleRate);
                    int off = 0;
                    while (off < p.pcm.length && running) {
                        if (want != 0) { track.pause(); track.flush(); track.play(); break; }   // a newer rep: cut this number
                        int w = track.write(p.pcm, off, Math.min(480, p.pcm.length - off));
                        if (w <= 0) break;
                        off += w;
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "play " + n, t);
                    releaseTrack();
                }
            }
        } catch (InterruptedException ignored) {
        } finally {
            releaseTrack();
        }
    }

    private void requestFocus() {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                focusReq = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).setWillPauseWhenDucked(false).build();
                am.requestAudioFocus(focusReq);
            } else {
                am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
            }
        } catch (Exception e) { Log.w(TAG, "focus", e); }
    }
    private void abandonFocus() {
        try {
            if (am == null) return;
            if (Build.VERSION.SDK_INT >= 26) { if (focusReq != null) am.abandonAudioFocusRequest(focusReq); }
            else am.abandonAudioFocus(null);
        } catch (Exception ignored) {}
    }
}
