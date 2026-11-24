package tech.agantay.fitness;

/**
 * Russian numerals for the voice announcements: cardinal numbers with gender, noun forms with number agreement
 * (1 минута, 2 минуты, 5 минут, 11 минут, 21 минута …) and the few compound phrases the app speaks
 * (distance «полтора километра», «два с половиной километра»; pace «шесть минут сорок три секунды на километр»).
 * Pure functions, no Android classes → unit-tested on the JVM against an independent oracle (see RuNumTest).
 */
final class RuNum {
    private RuNum() {}

    enum G { M, F, N }

    private static final String[] ONES_M = { "ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять" };
    private static final String[] TEENS = { "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать" };
    private static final String[] TENS = { "", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто" };
    private static final String[] HUNDREDS = { "", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот" };

    /** «один / одна / одно», «два / две / два» */
    private static String one(int d, G g) {
        if (d == 1) return g == G.F ? "одна" : g == G.N ? "одно" : "один";
        if (d == 2) return g == G.F ? "две" : "два";
        return ONES_M[d];
    }

    private static String triple(int n, G g) {   // 1..999
        StringBuilder sb = new StringBuilder();
        int h = n / 100, r = n % 100;
        if (h > 0) sb.append(HUNDREDS[h]);
        if (r >= 10 && r < 20) { if (sb.length() > 0) sb.append(' '); sb.append(TEENS[r - 10]); }
        else {
            int t = r / 10, o = r % 10;
            if (t >= 2) { if (sb.length() > 0) sb.append(' '); sb.append(TENS[t]); }
            if (o > 0) { if (sb.length() > 0) sb.append(' '); sb.append(one(o, g)); }
        }
        return sb.toString();
    }

    /** cardinal number 0..999 999 in the given gender: words(21, F) = «двадцать одна» */
    static String words(int n, G g) {
        if (n < 0 || n > 999_999) throw new IllegalArgumentException("out of range: " + n);
        if (n == 0) return ONES_M[0];
        StringBuilder sb = new StringBuilder();
        int th = n / 1000, rest = n % 1000;
        if (th > 0) {
            sb.append(triple(th, G.F)).append(' ').append(plural(th, "тысяча", "тысячи", "тысяч"));
        }
        if (rest > 0) { if (sb.length() > 0) sb.append(' '); sb.append(triple(rest, g)); }
        return sb.toString();
    }
    static String words(int n) { return words(n, G.M); }

    /** noun form after a number: 1 → one, 2–4 → few, 0 / 5–20 → many; 11–14 are always «many» */
    static String plural(int n, String one, String few, String many) {
        int a = Math.abs(n) % 100, b = a % 10;
        if (a >= 11 && a <= 14) return many;
        if (b == 1) return one;
        if (b >= 2 && b <= 4) return few;
        return many;
    }

    /** number + noun with agreement: count(21, F, …) = «двадцать одна минута» */
    static String count(int n, G g, String one, String few, String many) { return words(n, g) + " " + plural(n, one, few, many); }

    static String minutes(int n) { return count(n, G.F, "минута", "минуты", "минут"); }
    static String seconds(int n) { return count(n, G.F, "секунда", "секунды", "секунд"); }
    static String hours(int n) { return count(n, G.M, "час", "часа", "часов"); }
    static String meters(int n) { return count(n, G.M, "метр", "метра", "метров"); }
    static String kilometers(int n) { return count(n, G.M, "километр", "километра", "километров"); }

    /**
     * Distance for the milestone announcements and the summary.
     * 500 → «пятьсот метров», 1000 → «километр», 1500 → «полтора километра», 2000 → «два километра»,
     * 2500 → «два с половиной километра», 5000 → «пять километров», 21500 → «двадцать один с половиной километра»,
     * 2340 → «два километра триста сорок метров». The lone «километр» (1000 m) is how the milestone sounds on the radio.
     */
    static String distance(int m) {
        if (m < 0) m = 0;
        int km = m / 1000, rem = m % 1000;
        if (km == 0) return meters(rem);
        if (rem == 0) return km == 1 ? "километр" : kilometers(km);
        if (rem == 500) return km == 1 ? "полтора километра" : words(km, G.M) + " с половиной километра";
        return kilometers(km) + " " + meters(rem);
    }

    /** pace per km: «шесть минут сорок три секунды на километр», «семь минут на километр» (whole minutes: no seconds) */
    static String pace(int secPerKm) {
        int m = secPerKm / 60, s = secPerKm % 60;
        String t = m > 0 ? minutes(m) : "";
        if (s > 0 || m == 0) t = (t.isEmpty() ? "" : t + " ") + seconds(s);
        return t + " на километр";
    }

    /** duration: «четырнадцать минут тридцать секунд», «один час пять минут» (no seconds from one hour on), «двадцать секунд» */
    static String duration(int sec) {
        if (sec < 0) sec = 0;
        int h = sec / 3600, m = sec % 3600 / 60, s = sec % 60;
        StringBuilder sb = new StringBuilder();
        if (h > 0) sb.append(hours(h));
        if (m > 0) { if (sb.length() > 0) sb.append(' '); sb.append(minutes(m)); }
        if (s > 0 && h == 0) { if (sb.length() > 0) sb.append(' '); sb.append(seconds(s)); }
        if (sb.length() == 0) sb.append(seconds(0));
        return sb.toString();
    }
}
