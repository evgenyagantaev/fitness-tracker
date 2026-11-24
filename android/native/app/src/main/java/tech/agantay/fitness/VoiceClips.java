package tech.agantay.fitness;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Maps spoken Russian phrases from RunPhrases/RuNum to bundled offline audio clips (Opus in assets/voice/).
 * Pure Java so JVM tests and the asset generator share the exact same inventory and resolution logic.
 */
final class VoiceClips {
    private VoiceClips() {}

    static final String GAP = "__GAP__";
    static final String XFADE = "__XFADE__";

    static final int MIN_HR = 40, MAX_HR = 220;
    static final int MIN_CAD = 60, MAX_CAD = 240;
    static final int MIN_PACE_MIN = 2, MAX_PACE_MIN = 25;
    static final int MAX_DIST_M = 43000;
    static final int MAX_FINISH_MIN = 300;

    private static final Map<String, String> EXACT = new HashMap<>();
    private static final Map<String, Integer> CUR_PACE_MIN = new HashMap<>();
    private static final Map<String, Integer> FIN_PACE_MIN = new HashMap<>();
    private static final Map<String, Integer> PACE_SEC = new HashMap<>();
    private static final LinkedHashMap<String, String[]> INVENTORY = new LinkedHashMap<>();

    private static void addWhole(String key, String text) {
        EXACT.put(text, key);
        INVENTORY.put(key, new String[] { "W", text });
    }

    static {
        addWhole("ev.start", RunPhrases.started());
        addWhole("ev.pause", RunPhrases.paused());
        addWhole("ev.resume", RunPhrases.resumed());
        addWhole("ev.end", RunPhrases.ended());
        addWhole("ev.test", RunPhrases.test());

        for (int b = 100; b <= 220; b += 20) addWhole("hr." + b, RunPhrases.hrOver(b));
        for (int b = MIN_HR; b <= MAX_HR; b++) {
            addWhole("curhr." + b, "Текущий пульс " + RuNum.words(b) + ".");
            addWhole("fin.hr." + b, "Средний пульс " + RuNum.words(b) + ".");
        }
        for (int c = MIN_CAD; c <= MAX_CAD; c++) addWhole("curcad." + c, "Текущий каденс " + RuNum.words(c) + ".");

        for (int m = 500; m <= MAX_DIST_M; m += 500) addWhole("dist." + m, RunPhrases.distance(m));
        for (int m = 100; m <= MAX_DIST_M; m += 100) {
            if (m % 500 != 0) addWhole("fin.dist." + m, RunPhrases.distance(m));
        }

        for (int s = 10; s <= 40; s += 10) addWhole("fin.time.s" + s, "Время " + RuNum.seconds(s) + ".");
        for (int m = 1; m <= MAX_FINISH_MIN; m++) addWhole("fin.time.m" + m, "Время " + RuNum.duration(m * 60) + ".");

        for (int m = MIN_PACE_MIN; m <= MAX_PACE_MIN; m++) {
            String kCur0 = "pace." + m + ".0", tCur0 = "Текущий темп " + RuNum.pace(m * 60) + ".";
            addWhole(kCur0, tCur0);

            String kFin0 = "fin.pace." + m + ".0", tFin0 = "Средний темп " + RuNum.pace(m * 60) + ".";
            addWhole(kFin0, tFin0);

            String minWords = RuNum.minutes(m);
            CUR_PACE_MIN.put("Текущий темп " + minWords, m);
            FIN_PACE_MIN.put("Средний темп " + minWords, m);
            INVENTORY.put("paceA." + m, new String[] { "A", "Текущий темп " + minWords + " пятьдесят секунд на километр." });
            INVENTORY.put("fin.paceA." + m, new String[] { "A", "Средний темп " + minWords + " пятьдесят секунд на километр." });
        }
        for (int s = 1; s <= 59; s++) {
            String suf = RuNum.seconds(s) + " на километр.";
            PACE_SEC.put(suf, s);
            INVENTORY.put("paceB." + s, new String[] { "B", "Текущий темп шесть минут " + suf });
        }
    }

    static Set<String> inventoryKeys() { return INVENTORY.keySet(); }
    static Map<String, String[]> inventory() { return INVENTORY; }

    /**
     * Resolves an announcement text to clip keys + GAP/XFADE markers.
     * Returns null if any part is outside the pre-rendered inventory (caller falls back to TTS).
     */
    static List<String> resolve(String text) {
        if (text == null) return null;
        String trimmed = text.trim();
        if (trimmed.isEmpty()) return null;

        String exact = EXACT.get(trimmed);
        if (exact != null) {
            List<String> one = new ArrayList<>(1);
            one.add(exact);
            return one;
        }

        String[] parts = trimmed.split("(?<=\\.)\\s+");
        List<String> out = new ArrayList<>();
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) out.add(GAP);
            if (!appendSentence(parts[i], out)) return null;
        }
        return out;
    }

    private static boolean appendSentence(String s, List<String> out) {
        String ex = EXACT.get(s);
        if (ex != null) { out.add(ex); return true; }

        int cut = s.indexOf(" минут");
        if (cut > 0) {
            int sp = s.indexOf(' ', cut + 1);
            if (sp > 0 && sp + 1 < s.length()) {
                String prefix = s.substring(0, sp);
                String suffix = s.substring(sp + 1);
                Integer sec = PACE_SEC.get(suffix);
                if (sec != null) {
                    Integer curMin = CUR_PACE_MIN.get(prefix);
                    if (curMin != null) {
                        out.add("paceA." + curMin);
                        out.add(XFADE);
                        out.add("paceB." + sec);
                        return true;
                    }
                    Integer finMin = FIN_PACE_MIN.get(prefix);
                    if (finMin != null) {
                        out.add("fin.paceA." + finMin);
                        out.add(XFADE);
                        out.add("paceB." + sec);
                        return true;
                    }
                }
            }
        }
        return false;
    }

    public static void main(String[] args) {
        for (Map.Entry<String, String[]> e : INVENTORY.entrySet()) {
            System.out.println(e.getValue()[0] + "\t" + e.getKey() + "\t" + e.getValue()[1]);
        }
    }
}
