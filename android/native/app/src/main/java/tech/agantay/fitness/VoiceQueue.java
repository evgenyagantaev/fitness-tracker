package tech.agantay.fitness;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Scheduling of the spoken announcements (pure logic, time is passed in).
 *  - nothing is ever cut off: next() hands out an item only when the previous one has finished;
 *  - regular announcements (2-min summary, distance) are at least REGULAR_GAP_MS apart (end of one → start of the next) and wait
 *    EVENT_THEN_REGULAR_MS after any other speech, so they never run together;
 *  - events (start, pause, resume, HR threshold) go first, as soon as the speech in progress is over (+ a short breath);
 *  - stale items are dropped (every item has a time to live), one item per key (a newer 2-min summary replaces an older one),
 *    «paused» and «resumed» that are both still waiting cancel each other;
 *  - FINAL (the summary at Стоп) flushes everything else and is spoken as soon as possible.
 */
final class VoiceQueue {
    static final int EVENT = 0, REGULAR = 1, FINAL = 2;
    static final long REGULAR_GAP_MS = 20_000, EVENT_THEN_REGULAR_MS = 6_000, EVENT_GAP_MS = 1_200;

    static final class Item {
        final String text, key; final int kind; final long at, ttlMs;
        Item(String text, int kind, String key, long at, long ttlMs) { this.text = text; this.kind = kind; this.key = key; this.at = at; this.ttlMs = ttlMs; }
        @Override public String toString() { return (kind == REGULAR ? "R " : kind == FINAL ? "F " : "E ") + text; }
    }

    private final List<Item> q = new ArrayList<>();
    private Item speaking = null;
    private long lastEnd = -1, lastRegularEnd = -1;
    int dropped = 0;

    synchronized void offer(String text, int kind, String key, long now, long ttlMs) {
        if (text == null || text.isEmpty()) return;
        if (kind == FINAL) { dropped += q.size(); q.clear(); q.add(new Item(text, kind, key, now, Long.MAX_VALUE / 4)); return; }
        if ("pause".equals(key) || "resume".equals(key)) {
            String other = "pause".equals(key) ? "resume" : "pause";
            for (Iterator<Item> it = q.iterator(); it.hasNext(); ) if (other.equals(it.next().key)) { it.remove(); dropped += 2; return; }
        }
        if (key != null) for (Iterator<Item> it = q.iterator(); it.hasNext(); ) if (key.equals(it.next().key)) { it.remove(); dropped++; }
        q.add(new Item(text, kind, key, now, ttlMs));
    }

    /** the item to speak right now, or null (then try again later); the caller must call started() / done() */
    synchronized Item next(long now) {
        if (speaking != null) return null;
        for (Iterator<Item> it = q.iterator(); it.hasNext(); ) { Item i = it.next(); if (now - i.at > i.ttlMs) { it.remove(); dropped++; } }
        Item best = null;
        for (Item i : q) if (ready(i, now) && (best == null || rank(i) > rank(best))) best = i;   // FIFO inside a class
        if (best == null) return null;
        q.remove(best);
        return best;
    }

    private static int rank(Item i) { return i.kind == FINAL ? 3 : i.kind == EVENT ? 2 : 1; }

    private boolean ready(Item i, long now) {
        if (lastEnd < 0) return true;
        if (i.kind != REGULAR) return now - lastEnd >= (i.kind == FINAL ? 300 : EVENT_GAP_MS);
        return now - lastEnd >= EVENT_THEN_REGULAR_MS && (lastRegularEnd < 0 || now - lastRegularEnd >= REGULAR_GAP_MS);
    }

    synchronized void started(Item i) { speaking = i; }
    synchronized void done(long now) {
        if (speaking != null && speaking.kind == REGULAR) lastRegularEnd = now;
        if (speaking != null) lastEnd = now;
        speaking = null;
    }
    synchronized boolean busy() { return speaking != null; }
    synchronized int size() { return q.size(); }
    synchronized boolean idle() { return speaking == null && q.isEmpty(); }
    synchronized void clear() { q.clear(); }
}
