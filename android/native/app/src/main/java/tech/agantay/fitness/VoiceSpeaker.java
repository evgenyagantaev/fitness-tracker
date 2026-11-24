package tech.agantay.fitness;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Locale;
import java.util.Set;

/**
 * v1.8: speaks the run announcements. A process-wide singleton (it outlives WorkoutService so the last sentence is not cut when the
 * service stops), driven by the VoiceQueue: one utterance at a time, never interrupted, audio focus with ducking
 * (USAGE_ASSISTANCE_NAVIGATION_GUIDANCE — the same stream a navigator uses, so it is heard over music and through headphones).
 * Engine: Google Speech Services when installed; voice: the best installed Russian FEMALE voice (offline first).
 */
final class VoiceSpeaker {
    static final String TAG = "VoiceSpeaker";
    static final String PREFS = "voice", GOOGLE_TTS = "com.google.android.tts";
    /** Google's Russian voices: the female ones, best first (determined by measuring the pitch of each, see README / VoiceProbeActivity) */
    static final String[] FEMALE_PREFERRED = { "ru-ru-x-dfc-local", "ru-ru-x-ruc-local", "ru-ru-x-rue-local", "ru-ru-x-dfc-network", "ru-ru-x-ruc-network", "ru-ru-x-rue-network" };
    // Gender measured on a Redmi Note 8 Pro by the debug VoiceProbeActivity (median F0 of the rendered sample):
    // dfc 207-212 Hz, ruc 204-216, rue 205-222 -> female; rud 156-161, ruf 126-130 -> male. Local (offline) voices come first: no network is needed mid-run.
    static final String[] MALE_KNOWN = { "ru-ru-x-rud", "ru-ru-x-ruf" };
    static final float RATE = 1.12f, PITCH = 1.0f;

    private static VoiceSpeaker inst;
    static synchronized VoiceSpeaker get(Context c) { if (inst == null) inst = new VoiceSpeaker(c.getApplicationContext()); return inst; }

    final Context app; final VoiceQueue q = new VoiceQueue();
    private final Handler h = new Handler(Looper.getMainLooper());
    private TextToSpeech tts; private volatile boolean ready = false, initializing = false;
    volatile String status = "idle", engine = null, voiceName = null, voiceGender = null;
    private final AudioManager am;
    private AudioFocusRequest focusReq;
    private VoiceQueue.Item current; private long currentSince;
    private int utt = 0;
    private final AudioAttributes attrs = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();

    private VoiceSpeaker(Context app) { this.app = app; am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE); }

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
        if (ready || initializing) return;
        initializing = true; status = "init";
        final String pkg = installed(GOOGLE_TTS) ? GOOGLE_TTS : null;
        h.post(() -> {
            try {
                tts = new TextToSpeech(app, st -> h.post(() -> onInit(st)), pkg);
            } catch (Exception e) { initializing = false; status = "error:" + e.getMessage(); Log.w(TAG, "TTS init", e); }
        });
    }
    private boolean installed(String pkg) { try { app.getPackageManager().getPackageInfo(pkg, 0); return true; } catch (Exception e) { return false; } }

    private void onInit(int st) {
        initializing = false;
        if (st != TextToSpeech.SUCCESS || tts == null) { status = "error:голосовой движок не запустился"; Log.w(TAG, "TTS init status " + st); return; }
        try {
            engine = tts.getDefaultEngine();
            tts.setAudioAttributes(attrs);
            Voice v = pickVoice(tts.getVoices(), app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("voice", ""));
            if (v == null) {
                int r = tts.setLanguage(new Locale("ru", "RU"));
                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) { status = "error:нет русского голоса (Настройки → Язык и ввод → Синтез речи)"; return; }
                status = "ok"; voiceName = "(по умолчанию)"; voiceGender = "?";
            } else {
                tts.setVoice(v); voiceName = v.getName(); voiceGender = genderOf(v.getName()); status = "ok";
            }
            tts.setSpeechRate(RATE); tts.setPitch(PITCH);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { h.post(() -> finished(id)); }
                @Override public void onError(String id) { h.post(() -> finished(id)); }
                @Override public void onError(String id, int code) { Log.w(TAG, "utterance error " + code); h.post(() -> finished(id)); }
            });
            ready = true;
            Log.i(TAG, "TTS ready: engine=" + engine + " voice=" + voiceName + " (" + voiceGender + ")");
            pump();
        } catch (Exception e) { status = "error:" + e.getMessage(); Log.w(TAG, "TTS setup", e); }
    }

    static String genderOf(String name) {
        if (name == null) return "?";
        String n = name.toLowerCase(Locale.ROOT);
        for (String f : FEMALE_PREFERRED) if (n.startsWith(f.substring(0, f.lastIndexOf('-')))) return "female";
        for (String m : MALE_KNOWN) if (n.startsWith(m)) return "male";
        if (n.contains("female")) return "female"; if (n.contains("male")) return "male";
        return "?";
    }

    /** the Russian voice to use: the one chosen in settings, else the best female one (offline before network), never a known male one while another exists */
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
            o.put("status", status); o.put("engine", engine); o.put("voice", voiceName); o.put("gender", voiceGender);
            JSONArray vs = new JSONArray();
            if (tts != null && ready) { Set<Voice> all = tts.getVoices(); if (all != null) for (Voice v : all) if (v.getLocale() != null && "ru".equals(v.getLocale().getLanguage())) vs.put(v.getName() + (v.isNetworkConnectionRequired() ? " (сеть)" : "")); }
            o.put("voices", vs);
            RunVoice.Cfg c = loadCfg(app);
            o.put("enabled", c.enabled).put("events", c.events).put("hr", c.hr).put("summary", c.summary).put("distance", c.distance);
        } catch (Exception ignored) {}
        return o;
    }

    // ---- speaking ----
    /** a one-off phrase (test, end of run): flushes what is waiting */
    void sayNow(String text) {
        ensure();
        q.offer(text, VoiceQueue.FINAL, "final", SystemClock.elapsedRealtime(), 0);
        h.post(this::pump);
    }
    boolean idle() { return q.idle() && current == null; }

    /** called by the service every second and by the speaker itself while something is waiting */
    void pump() {
        h.removeCallbacks(pumpRun);
        if (!q.idle() || current != null) h.postDelayed(pumpRun, 400);
        if (!ready) { if (!q.idle() && !initializing && !status.startsWith("error")) ensure(); if (status.startsWith("error")) q.clear(); return; }
        long now = SystemClock.elapsedRealtime();
        if (current != null) {
            // watchdog: the engine never reported the end
            if (now - currentSince > 8000 + current.text.length() * 140L) { Log.w(TAG, "utterance watchdog"); try { tts.stop(); } catch (Exception ignored) {} finished(null); }
            return;
        }
        VoiceQueue.Item it = q.next(now);
        if (it == null) return;
        q.started(it); current = it; currentSince = now;
        requestFocus();
        Bundle p = new Bundle();
        String id = "u" + (++utt);
        int r = tts.speak(it.text, TextToSpeech.QUEUE_FLUSH, p, id);
        Log.i(TAG, "say[" + (it.kind == VoiceQueue.REGULAR ? "R" : it.kind == VoiceQueue.FINAL ? "F" : "E") + "]: " + it.text + (r == TextToSpeech.SUCCESS ? "" : "  (speak() returned " + r + ")"));
        if (r != TextToSpeech.SUCCESS) finished(id);
    }
    private final Runnable pumpRun = this::pump;

    private void finished(String id) {
        if (current == null) return;
        current = null;
        q.done(SystemClock.elapsedRealtime());
        abandonFocus();
        pump();
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
