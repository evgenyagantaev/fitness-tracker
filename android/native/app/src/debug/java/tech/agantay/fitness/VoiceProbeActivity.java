package tech.agantay.fitness;

import android.app.Activity;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/** Debug tool: which engines / voices does this phone have, and how do the Russian ones sound (WAV files for pitch analysis on the box). */
public class VoiceProbeActivity extends Activity {
    static final String TAG = "VoiceProbe";
    private TextToSpeech tts;
    private final List<Voice> todo = new ArrayList<>();

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        tts = new TextToSpeech(this, st -> {
            if (st != TextToSpeech.SUCCESS) { Log.e(TAG, "init failed " + st); finish(); return; }
            Log.i(TAG, "default engine: " + tts.getDefaultEngine());
            for (TextToSpeech.EngineInfo e : tts.getEngines()) Log.i(TAG, "engine: " + e.name + " (" + e.label + ")");
            for (Voice v : tts.getVoices()) {
                boolean ru = v.getLocale() != null && "ru".equals(v.getLocale().getLanguage());
                if (ru) { Log.i(TAG, "voice: " + v.getName() + " locale=" + v.getLocale() + " quality=" + v.getQuality() + " latency=" + v.getLatency() + " network=" + v.isNetworkConnectionRequired() + " features=" + v.getFeatures()); todo.add(v); }
            }
            Log.i(TAG, "russian voices: " + todo.size());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { Log.i(TAG, "rendered " + id); next(); }
                @Override public void onError(String id) { Log.e(TAG, "render error " + id); next(); }
            });
            next();
        }, VoiceSpeaker.GOOGLE_TTS);
    }

    private void next() {
        if (todo.isEmpty()) { Log.i(TAG, "PROBE DONE"); runOnUiThread(this::finish); return; }
        Voice v = todo.remove(0);
        File dir = new File(getFilesDir(), "probe"); dir.mkdirs();
        tts.setVoice(v);
        tts.setSpeechRate(VoiceSpeaker.RATE);
        int r = tts.synthesizeToFile("Регистрация бега началась. Пульс превысил сто двадцать. Дистанция полтора километра. Текущий темп шесть минут сорок три секунды на километр.", null,
            new File(dir, v.getName() + ".wav"), v.getName());
        if (r != TextToSpeech.SUCCESS) { Log.e(TAG, "synthesizeToFile " + r + " for " + v.getName()); next(); }
    }

    @Override protected void onDestroy() { if (tts != null) tts.shutdown(); super.onDestroy(); }
}
