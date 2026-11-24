package tech.agantay.fitness;

/** The words the app says during a run: short radio-style phrases, every number spelled out with correct agreement. */
final class RunPhrases {
    private RunPhrases() {}

    static String started() { return "Регистрация бега началась."; }
    static String paused() { return "Регистрация бега приостановлена."; }
    static String resumed() { return "Регистрация бега возобновлена."; }
    static String ended() { return "Регистрация бега завершена."; }

    /** «Пульс превысил сто двадцать.» */
    static String hrOver(int bpm) { return "Пульс превысил " + RuNum.words(bpm) + "."; }

    /** every item is optional (null / ≤ 0 → skipped): «Текущий пульс сто тридцать два. Текущий каденс сто пятьдесят семь. Текущий темп шесть минут сорок три секунды на километр.» */
    static String summary(int hr, int cadence, int paceSecPerKm) {
        StringBuilder sb = new StringBuilder();
        if (hr > 0) sb.append("Текущий пульс ").append(RuNum.words(hr)).append(". ");
        if (cadence > 0) sb.append("Текущий каденс ").append(RuNum.words(cadence)).append(". ");
        if (paceSecPerKm > 0) sb.append("Текущий темп ").append(RuNum.pace(paceSecPerKm)).append(". ");
        return sb.toString().trim();
    }

    /** «Дистанция полтора километра.» */
    static String distance(int meters) { return "Дистанция " + RuNum.distance(meters) + "."; }

    /** at Стоп: distance rounded to 10 m; time, average pace and average HR only when known */
    static String finish(int distM, int movingS, int paceSecPerKm, int hrAvg) {
        StringBuilder sb = new StringBuilder(ended());
        if (distM >= 10) sb.append(" Дистанция ").append(RuNum.distance(Math.round(distM / 10f) * 10)).append('.');
        if (movingS >= 5) sb.append(" Время ").append(RuNum.duration(movingS)).append('.');
        if (paceSecPerKm > 0) sb.append(" Средний темп ").append(RuNum.pace(paceSecPerKm)).append('.');
        if (hrAvg > 0) sb.append(" Средний пульс ").append(RuNum.words(hrAvg)).append('.');
        return sb.toString();
    }

    static String test() { return "Проверка связи. Регистрация бега началась. Дистанция полтора километра. Текущий темп шесть минут сорок три секунды на километр."; }
}
