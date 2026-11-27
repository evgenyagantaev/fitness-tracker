package tech.agantay.fitness;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * v1.8.1: speaks the run announcements. A process-wide singleton (it outlives WorkoutService so the last sentence is not cut when the
 * service stops), driven by the VoiceQueue: one utterance at a time, never interrupted, audio focus with ducking
 * (USAGE_ASSISTANCE_NAVIGATION_GUIDANCE).
 *
 * Primary output: bundled offline Silero v5.1 (xenia) Opus clips processed with radio filter B (400-3000 Hz + compression +
 * continuous radio hiss bed), stitched seamlessly in PCM via ClipPlayer + VoicePcm.
 * Fallback: Android TextToSpeech (Google Russian female voice) only if a phrase is outside the clip inventory or clip decoding fails.
 */
final class VoiceSpeaker {
    static final String TAG = "VoiceSpeaker";
    static final String PREFS = "voice", GOOGLE_TTS = "com.google.android.tts";
    static final String[] FEMALE_PREFERRED = { "ru-ru-x-dfc-local", "ru-ru-x-ruc-local", "ru-ru-x-rue-local", "ru-ru-x-dfc-network", "ru-ru-x-ruc-network", "ru-ru-x-rue-network" };
    static final String[] MALE_KNOWN = { "ru-ru-x-rud", "ru-ru-x-ruf" };
    static final float RATE = 1.12f, PITCH = 1.0f;

    private static VoiceSpeaker inst;
    static synchronized VoiceSpeaker get(Context c) { if (inst == null) inst = new VoiceSpeaker(c.getApplicationContext()); return inst; }

    final Context app;
    final VoiceQueue q = new VoiceQueue();
    final ClipPlayer clipPlayer;
    private final Handler h = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private volatile boolean ttsReady = false, ttsInitializing = false, ttsFailed = false;
    volatile String status = "idle", engine = null, voiceName = null, voiceGender = null;
    private volatile String ttsStatus = "idle", ttsEngine = null, ttsVoiceName = null, ttsVoiceGender = null;
    private final AudioManager am;
    private final PowerManager.WakeLock playWakeLock;
    private AudioFocusRequest focusReq;
    private VoiceQueue.Item current;
    private String currentId;
    private long currentSince;
    private int utt = 0;
    private final AudioAttributes attrs = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build();

    private VoiceSpeaker(Context app) {
        this.app = app;
        this.am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        this.clipPlayer = new ClipPlayer(app);
        PowerManager pm = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
        this.playWakeLock = pm != null ? pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fitness:voice") : null;
        if (this.playWakeLock != null) this.playWakeLock.setReferenceCounted(false);
        if (clipPlayer.hasClips()) {
            status = "ok";
            engine = "silero-xenia (рация B)";
            voiceName = "xenia";
            voiceGender = "female";
        }
    }

    // ---- settings (per device, SharedPreferences) ----
    static RunVoice.Cfg loadCfg(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        RunVoice.Cfg f = new RunVoice.Cfg();
        f.enabled = p.getBoolean("enabled", true); f.events = p.getBoolean("events", true); f.hr = p.getBoolean("hr", true);
        f.summary = p.getBoolean("summary", true); f.distance = p.getBoolean("distance", true);
        return f;
    }
    static void saveCfg(Context c, JSONObject o) {
        SharedPreferences.Editor e = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        for (String k : new String[] { "enabled", "events", "hr", "summary", "distance" }) if (o.has(k)) e.putBoolean(k, o.optBoolean(k, true));
        if (o.has("voice")) e.putString("voice", o.optString("voice", ""));
        e.apply();
    }

    // ---- engine ----
    synchronized void ensure() {
        if (clipPlayer.hasClips()) {
            status = "ok"; engine = "silero-xenia (рация B)"; voiceName = "xenia"; voiceGender = "female";
        }
        if (ttsReady || ttsInitializing || ttsFailed) return;
        ttsInitializing = true;
        if (!clipPlayer.hasClips()) status = "init";
        ttsStatus = "init";
        final String pkg = installed(GOOGLE_TTS) ? GOOGLE_TTS : null;
        h.post(() -> {
            try {
                tts = new TextToSpeech(app, st -> h.post(() -> onInit(st)), pkg);
            } catch (Exception e) {
                ttsInitializing = false; ttsFailed = true; ttsStatus = "error:" + e.getMessage();
                if (!clipPlayer.hasClips()) status = ttsStatus;
                Log.w(TAG, "TTS init", e);
            }
        });
    }
    private boolean installed(String pkg) { try { app.getPackageManager().getPackageInfo(pkg, 0); return true; } catch (Exception e) { return false; } }

    private void onInit(int st) {
        ttsInitializing = false;
        if (st != TextToSpeech.SUCCESS || tts == null) {
            ttsFailed = true; ttsStatus = "error:голосовой движок не запустился";
            if (!clipPlayer.hasClips()) status = ttsStatus;
            Log.w(TAG, "TTS init status " + st);
            return;
        }
        try {
            ttsEngine = tts.getDefaultEngine();
            tts.setAudioAttributes(attrs);
            Voice v = pickVoice(tts.getVoices(), app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("voice", ""));
            if (v == null) {
                int r = tts.setLanguage(new Locale("ru", "RU"));
                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                    ttsFailed = true; ttsStatus = "error:нет русского голоса (Настройки → Язык и ввод → Синтез речи)";
                    if (!clipPlayer.hasClips()) status = ttsStatus;
                    return;
                }
                ttsStatus = "ok"; ttsVoiceName = "(по умолчанию)"; ttsVoiceGender = "?";
            } else {
                tts.setVoice(v); ttsVoiceName = v.getName(); ttsVoiceGender = genderOf(v.getName()); ttsStatus = "ok";
            }
            tts.setSpeechRate(RATE); tts.setPitch(PITCH);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { h.post(() -> finished(id)); }
                @Override public void onError(String id) { h.post(() -> finished(id)); }
                @Override public void onError(String id, int code) { Log.w(TAG, "utterance error " + code); h.post(() -> finished(id)); }
            });
            ttsReady = true;
            if (!clipPlayer.hasClips()) {
                status = ttsStatus; engine = ttsEngine; voiceName = ttsVoiceName; voiceGender = ttsVoiceGender;
            }
            Log.i(TAG, "TTS fallback ready: engine=" + ttsEngine + " voice=" + ttsVoiceName + " (" + ttsVoiceGender + ")");
            pump();
        } catch (Exception e) {
            ttsFailed = true; ttsStatus = "error:" + e.getMessage();
            if (!clipPlayer.hasClips()) status = ttsStatus;
            Log.w(TAG, "TTS setup", e);
        }
    }

    static String genderOf(String name) {
        if (name == null) return "?";
        String n = name.toLowerCase(Locale.ROOT);
        for (String f : FEMALE_PREFERRED) if (n.startsWith(f.substring(0, f.lastIndexOf('-')))) return "female";
        for (String m : MALE_KNOWN) if (n.startsWith(m)) return "male";
        if (n.contains("female")) return "female"; if (n.contains("male")) return "male";
        return "?";
    }

    static Voice pickVoice(Set<Voice> all, String wanted) {
        if (all == null) return null;
        ArrayList<Voice> ru = new ArrayList<>();
        for (Voice v : all) if (v.getLocale() != null && "ru".equals(v.getLocale().getLanguage())) ru.add(v);
        if (ru.isEmpty()) return null;
        if (wanted != null && !wanted.isEmpty()) for (Voice v : ru) if (v.getName().equals(wanted)) return v;
        Voice best = null; int bestScore = Integer.MIN_VALUE;
        for (Voice v : ru) {
            int sc = score(v.getName(), v.isNetworkConnectionRequired(), v.getQuality());
            if (sc > bestScore) { bestScore = sc; best = v; }
        }
        return best;
    }
    static int score(String name, boolean network, int quality) {
        int s = quality / 100 - (network ? 50 : 0);
        String g = genderOf(name);
        if (g.equals("female")) s += 1000; else if (g.equals("male")) s -= 1000;
        for (int i = 0; i < FEMALE_PREFERRED.length; i++) if (name.equalsIgnoreCase(FEMALE_PREFERRED[i])) s += 100 - i * 10;
        return s;
    }

    JSONObject info() {
        JSONObject o = new JSONObject();
        try {
            o.put("status", status).put("engine", engine).put("voice", voiceName).put("gender", voiceGender)
             .put("clips", clipPlayer.hasClips());
            JSONArray vs = new JSONArray();
            if (tts != null && ttsReady) { Set<Voice> all = tts.getVoices(); if (all != null) for (Voice v : all) if (v.getLocale() != null && "ru".equals(v.getLocale().getLanguage())) vs.put(v.getName() + (v.isNetworkConnectionRequired() ? " (сеть)" : "")); }
            o.put("voices", vs);
            RunVoice.Cfg c = loadCfg(app);
            o.put("enabled", c.enabled).put("events", c.events).put("hr", c.hr).put("summary", c.summary).put("distance", c.distance);
        } catch (Exception ignored) {}
        return o;
    }

    // ---- speaking ----
    void sayNow(String text) {
        ensure();
        q.offer(text, VoiceQueue.FINAL, "final", SystemClock.elapsedRealtime(), 0);
        h.post(this::pump);
    }
    boolean idle() { return q.idle() && current == null; }

    private static String kindTag(VoiceQueue.Item it) {
        return it.kind == VoiceQueue.REGULAR ? "R" : it.kind == VoiceQueue.FINAL ? "F" : "E";
    }

    void pump() {
        h.removeCallbacks(pumpRun);
        if (!q.idle() || current != null) h.postDelayed(pumpRun, 400);
        long now = SystemClock.elapsedRealtime();
        if (current != null) {
            if (now - currentSince > 8000 + current.text.length() * 140L) {
                Log.w(TAG, "utterance watchdog");
                try { if (tts != null) tts.stop(); } catch (Exception ignored) {}
                finished(currentId);
            }
            return;
        }
        if (q.idle()) return;

        // peek via next(now) only when at least one output path can speak it
        VoiceQueue.Item it = q.next(now);
        if (it == null) return;

        List<String> clips = VoiceClips.resolve(it.text);
        if (clips != null && clipPlayer.canPlay(clips)) {
            String id = "c" + (++utt);
            q.started(it); current = it; currentId = id; currentSince = now;
            acquirePlayWakeLock();
            requestFocus();
            Log.i(TAG, "say[" + kindTag(it) + ",clips=" + clips.size() + "]: " + it.text);
            EventLog.add("voice start " + kindTag(it) + " key=" + it.key + " waited=" + (now - it.at) + "ms via=clips");
            clipPlayer.playAsync(clips, attrs, () -> h.post(() -> finished(id)), () -> h.post(() -> fallbackTts(it, id)));
            return;
        }

        // Needs Google TTS fallback
        if (!ttsReady) {
            if (!ttsInitializing && !ttsFailed) ensure();
            if (ttsFailed) {
                Log.w(TAG, "dropping unplayable utterance (no clip and no TTS): " + it.text);
                q.started(it); q.done(now);
            } else {
                // re-offer keeping priority so it speaks as soon as TTS initializes
                q.offer(it.text, it.kind, it.key, it.at, it.ttlMs);
            }
            return;
        }
        String id = "u" + (++utt);
        q.started(it); current = it; currentId = id; currentSince = now;
        acquirePlayWakeLock();
        requestFocus();
        speakTts(it, id);
    }
    private final Runnable pumpRun = this::pump;

    private void fallbackTts(VoiceQueue.Item it, String id) {
        if (current == null || !id.equals(currentId)) return;
        if (!ttsReady) { finished(id); return; }
        speakTts(it, id);
    }

    private void speakTts(VoiceQueue.Item it, String id) {
        Bundle p = new Bundle();
        EventLog.add("voice start " + kindTag(it) + " key=" + it.key + " waited=" + (SystemClock.elapsedRealtime() - it.at) + "ms via=tts");
        int r = tts.speak(it.text, TextToSpeech.QUEUE_FLUSH, p, id);
        Log.i(TAG, "say[" + kindTag(it) + ",tts]: " + it.text + (r == TextToSpeech.SUCCESS ? "" : " (speak()=" + r + ")"));
        if (r != TextToSpeech.SUCCESS) finished(id);
    }

    private void finished(String id) {
        if (current == null) return;
        if (id != null && !id.equals(currentId)) return;
        EventLog.add("voice end key=" + (current.key) + " took=" + (SystemClock.elapsedRealtime() - currentSince) + "ms");
        current = null;
        currentId = null;
        releasePlayWakeLock();
        q.done(SystemClock.elapsedRealtime());
        abandonFocus();
        pump();
    }

    @SuppressLint("WakelockTimeout")
    private void acquirePlayWakeLock() {
        try { if (playWakeLock != null) playWakeLock.acquire(35_000L); } catch (Exception ignored) {}
    }
    private void releasePlayWakeLock() {
        try { if (playWakeLock != null && playWakeLock.isHeld()) playWakeLock.release(); } catch (Exception ignored) {}
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
            if (Build.VERSION.SDK_INT >= 26) { if (focusReq != null) am.abandonAudioFocusRequest(focusReq); }
            else am.abandonAudioFocus(null);
        } catch (Exception ignored) {}
    }
}
