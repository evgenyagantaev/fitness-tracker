package tech.agantay.fitness;

import static org.junit.Assert.*;

import org.junit.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Russian numerals and phrases. The oracle for 0–999 (both genders) is an independent library (num2words), see ru-numerals.tsv. */
public class RuNumTest {
    static final List<String[]> ORACLE = new ArrayList<>();
    static {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(RuNumTest.class.getResourceAsStream("/ru-numerals.tsv"), StandardCharsets.UTF_8))) {
            String l;
            while ((l = r.readLine()) != null) if (!l.startsWith("#") && !l.isEmpty()) ORACLE.add(l.split("\t"));
        } catch (Exception e) { throw new RuntimeException(e); }
    }
    static final Set<String> FEW = new HashSet<>(Arrays.asList("два", "две", "три", "четыре"));
    static final Set<String> ONE = new HashSet<>(Arrays.asList("один", "одна", "одно"));
    /** independent agreement rule: it depends only on the LAST word of the spelled numeral */
    static String agree(String numeral, String one, String few, String many) {
        String[] w = numeral.split(" "); String last = w[w.length - 1];
        return ONE.contains(last) ? one : FEW.contains(last) ? few : many;
    }

    @Test public void cardinalsMatchOracleForAllNumbers0To999BothGenders() {
        assertEquals(1000, ORACLE.size());
        for (String[] r : ORACLE) {
            int n = Integer.parseInt(r[0]);
            assertEquals("m " + n, r[1], RuNum.words(n, RuNum.G.M));
            assertEquals("f " + n, r[2], RuNum.words(n, RuNum.G.F));
        }
    }

    @Test public void neuterAndThousands() {
        assertEquals("одно", RuNum.words(1, RuNum.G.N)); assertEquals("двадцать одно", RuNum.words(21, RuNum.G.N));
        assertEquals("два", RuNum.words(2, RuNum.G.N));
        assertEquals("одна тысяча", RuNum.words(1000)); assertEquals("две тысячи", RuNum.words(2000));
        assertEquals("пять тысяч", RuNum.words(5000)); assertEquals("двадцать одна тысяча", RuNum.words(21000));
        assertEquals("одиннадцать тысяч", RuNum.words(11000)); assertEquals("сто двадцать три тысячи четыреста пятьдесят шесть", RuNum.words(123456));
        assertEquals("девятьсот девяносто девять тысяч девятьсот девяносто девять", RuNum.words(999_999));
        try { RuNum.words(1_000_000); fail(); } catch (IllegalArgumentException expected) { }
    }

    @Test public void nounAgreementForEveryNumber0To300() {
        for (int n = 0; n <= 300; n++) {
            String m = RuNum.words(n, RuNum.G.M), f = RuNum.words(n, RuNum.G.F);
            assertEquals("минут " + n, f + " " + agree(f, "минута", "минуты", "минут"), RuNum.minutes(n));
            assertEquals("секунд " + n, f + " " + agree(f, "секунда", "секунды", "секунд"), RuNum.seconds(n));
            assertEquals("км " + n, m + " " + agree(m, "километр", "километра", "километров"), RuNum.kilometers(n));
            assertEquals("м " + n, m + " " + agree(m, "метр", "метра", "метров"), RuNum.meters(n));
            assertEquals("ч " + n, m + " " + agree(m, "час", "часа", "часов"), RuNum.hours(n));
            assertEquals("удар " + n, m + " " + agree(m, "удар", "удара", "ударов"), RuNum.count(n, RuNum.G.M, "удар", "удара", "ударов"));
            assertEquals("шаг " + n, m + " " + agree(m, "шаг", "шага", "шагов"), RuNum.count(n, RuNum.G.M, "шаг", "шага", "шагов"));
        }
        // the classic traps, spelled out
        assertEquals("одна минута", RuNum.minutes(1)); assertEquals("две минуты", RuNum.minutes(2)); assertEquals("пять минут", RuNum.minutes(5));
        assertEquals("одиннадцать минут", RuNum.minutes(11)); assertEquals("двенадцать минут", RuNum.minutes(12)); assertEquals("четырнадцать минут", RuNum.minutes(14));
        assertEquals("двадцать одна минута", RuNum.minutes(21)); assertEquals("двадцать две минуты", RuNum.minutes(22)); assertEquals("двадцать пять минут", RuNum.minutes(25));
        assertEquals("сто одиннадцать секунд", RuNum.seconds(111)); assertEquals("сто двадцать одна секунда", RuNum.seconds(121)); assertEquals("двести две секунды", RuNum.seconds(202));
        assertEquals("двадцать один километр", RuNum.kilometers(21)); assertEquals("двадцать два километра", RuNum.kilometers(22)); assertEquals("пятнадцать километров", RuNum.kilometers(15));
        assertEquals("сто один метр", RuNum.meters(101));
    }

    @Test public void paceForEveryMinuteSecondCombination() {
        for (int m = 1; m <= 59; m++) for (int s = 0; s <= 59; s++) {
            String exp = RuNum.words(m, RuNum.G.F) + " " + agree(RuNum.words(m, RuNum.G.F), "минута", "минуты", "минут")
                + (s > 0 ? " " + RuNum.words(s, RuNum.G.F) + " " + agree(RuNum.words(s, RuNum.G.F), "секунда", "секунды", "секунд") : "") + " на километр";
            assertEquals(m + ":" + s, exp, RuNum.pace(m * 60 + s));
        }
        assertEquals("шесть минут сорок три секунды на километр", RuNum.pace(6 * 60 + 43));
        assertEquals("семь минут на километр", RuNum.pace(420));
        assertEquals("одна минута одна секунда на километр", RuNum.pace(61));
        assertEquals("пять минут пятьдесят одна секунда на километр", RuNum.pace(5 * 60 + 51));
        assertEquals("четыре минуты двадцать две секунды на километр", RuNum.pace(4 * 60 + 22));
        assertEquals("десять минут двенадцать секунд на километр", RuNum.pace(612));
    }

    @Test public void durationForEverySecondUpTo2Hours() {
        for (int t = 0; t <= 7200; t++) {
            String d = RuNum.duration(t);
            assertFalse(t + " " + d, d.matches(".*\\d.*") || d.contains("  ") || d.startsWith(" ") || d.endsWith(" "));
            int h = t / 3600, m = t % 3600 / 60, s = t % 60;
            StringBuilder e = new StringBuilder();
            if (h > 0) e.append(RuNum.hours(h));
            if (m > 0) e.append(e.length() > 0 ? " " : "").append(RuNum.minutes(m));
            if (s > 0 && h == 0) e.append(e.length() > 0 ? " " : "").append(RuNum.seconds(s));
            if (e.length() == 0) e.append("ноль секунд");
            assertEquals("t=" + t, e.toString(), d);
        }
        assertEquals("четырнадцать минут тридцать секунд", RuNum.duration(14 * 60 + 30));
        assertEquals("один час пять минут", RuNum.duration(3900 + 20));
        assertEquals("два часа", RuNum.duration(7200)); assertEquals("двадцать одна секунда", RuNum.duration(21));
    }

    @Test public void distancePhrases() {
        String[][] t = {
            { "500", "пятьсот метров" }, { "1000", "километр" }, { "1500", "полтора километра" }, { "2000", "два километра" },
            { "2500", "два с половиной километра" }, { "3000", "три километра" }, { "3500", "три с половиной километра" }, { "4000", "четыре километра" },
            { "4500", "четыре с половиной километра" }, { "5000", "пять километров" }, { "5500", "пять с половиной километров".replace("километров", "километра") },
            { "10000", "десять километров" }, { "10500", "десять с половиной километра" }, { "11000", "одиннадцать километров" }, { "21000", "двадцать один километр" },
            { "21500", "двадцать один с половиной километра" }, { "22000", "двадцать два километра" }, { "42000", "сорок два километра" }, { "42500", "сорок два с половиной километра" },
            { "100000", "сто километров" }, { "101000", "сто один километр" },
            { "0", "ноль метров" }, { "10", "десять метров" }, { "150", "сто пятьдесят метров" }, { "701", "семьсот один метр" }, { "992", "девятьсот девяносто два метра" },
            { "1340", "один километр триста сорок метров" }, { "2340", "два километра триста сорок метров" }, { "12010", "двенадцать километров десять метров" },
            { "21121", "двадцать один километр сто двадцать один метр" }, { "5001", "пять километров один метр" },
        };
        for (String[] r : t) assertEquals(r[0], r[1], RuNum.distance(Integer.parseInt(r[0])));
        // every milestone of 500 m up to 100 km: no digits, plausible shape, «с половиной» always with the genitive singular
        for (int m = 500; m <= 100_000; m += 500) {
            String d = RuNum.distance(m);
            assertFalse(m + " " + d, d.matches(".*\\d.*"));
            if (m % 1000 == 500 && m > 1500) assertTrue(m + " " + d, d.endsWith(" с половиной километра"));
            if (m % 1000 == 0 && m > 1000) assertTrue(m + " " + d, d.matches(".*километр(а|ов)?"));
        }
    }

    @Test public void announcementTexts() {
        assertEquals("Регистрация бега началась.", RunPhrases.started());
        assertEquals("Регистрация бега приостановлена.", RunPhrases.paused());
        assertEquals("Регистрация бега возобновлена.", RunPhrases.resumed());
        assertEquals("Пульс превысил сто.", RunPhrases.hrOver(100));
        assertEquals("Пульс превысил сто двадцать.", RunPhrases.hrOver(120));
        assertEquals("Пульс превысил сто сорок.", RunPhrases.hrOver(140));
        assertEquals("Пульс превысил двести.", RunPhrases.hrOver(200));
        assertEquals("Текущий пульс сто тридцать два. Текущий каденс сто пятьдесят семь. Текущий темп шесть минут сорок три секунды на километр.", RunPhrases.summary(132, 157, 403));
        assertEquals("Текущий каденс сто пятьдесят семь. Текущий темп шесть минут сорок три секунды на километр.", RunPhrases.summary(0, 157, 403));
        assertEquals("Текущий пульс сто тридцать два. Текущий темп семь минут на километр.", RunPhrases.summary(132, 0, 420));
        assertEquals("", RunPhrases.summary(0, 0, 0));
        assertEquals("Дистанция пятьсот метров.", RunPhrases.distance(500));
        assertEquals("Дистанция километр.", RunPhrases.distance(1000));
        assertEquals("Дистанция полтора километра.", RunPhrases.distance(1500));
        assertEquals("Дистанция два километра.", RunPhrases.distance(2000));
        assertEquals("Дистанция два с половиной километра.", RunPhrases.distance(2500));
        assertEquals("Дистанция три километра.", RunPhrases.distance(3000));
        assertEquals("Регистрация бега завершена. Дистанция два километра триста сорок метров. Время четырнадцать минут тридцать секунд. Средний темп шесть минут сорок три секунды на километр. Средний пульс сто тридцать один.",
            RunPhrases.finish(2342, 14 * 60 + 30, 403, 131));
        assertEquals("Регистрация бега завершена. Дистанция семьсот десять метров. Время пять минут одна секунда. Средний темп семь минут одна секунда на километр.",
            RunPhrases.finish(708, 301, 421, 0));
        assertEquals("Регистрация бега завершена.", RunPhrases.finish(0, 0, 0, 0));
        // no digits in anything we speak, for every HR / cadence / pace the app can plausibly say
        for (int v = 30; v <= 230; v++) assertFalse(RunPhrases.summary(v, v + 5, 200 + v * 3).matches(".*\\d.*"));
        for (int v = 100; v <= 220; v += 20) assertFalse(RunPhrases.hrOver(v).matches(".*\\d.*"));
    }
}
