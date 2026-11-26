package tech.agantay.fitness;

import java.util.ArrayList;

/**
 * v1.10 push-up counter on top of the phone's proximity sensor (phone lies screen-up on the floor under the chest).
 * Pure logic, time is passed in. One rep = the sensor goes «near» (chest down) and then «far» again (chest up):
 *  - the near phase must last at least MIN_NEAR_MS (a flicker of the sensor is not a rep) and at most MAX_NEAR_MS (a hand over the
 *    phone, a pocket, a long rest at the bottom is not a rep);
 *  - two reps can't be closer than MIN_REP_GAP_MS (debounce of the up-phase);
 *  - the rep is counted at the «far» edge, i.e. when the chest has come back up.
 */
final class PushupCounter {
    static final long MIN_NEAR_MS = 120, MAX_NEAR_MS = 15_000, MIN_REP_GAP_MS = 400;

    private int reps = 0;
    private boolean near;
    private long nearSince;
    private long firstRepMs = -1, lastRepMs = -1;
    private final ArrayList<Long> repTimes = new ArrayList<>();

    PushupCounter(boolean nearAtStart, long nowMs) { near = nearAtStart; nearSince = nowMs; }

    /** proximity sensor value → near/far: «near» is below min(maxRange, 5 cm); binary sensors report 0 / maxRange */
    static boolean isNear(float value, float maxRange) {
        float limit = Math.min(maxRange, 5f);
        if (limit <= 0) limit = 5f;
        return value < limit;
    }

    /** @return true if this event counted a new rep */
    boolean onProximity(long ms, boolean nowNear) {
        if (nowNear == near) return false;
        near = nowNear;
        if (nowNear) { nearSince = ms; return false; }
        long dur = ms - nearSince;
        if (dur < MIN_NEAR_MS || dur > MAX_NEAR_MS) return false;
        if (lastRepMs >= 0 && ms - lastRepMs < MIN_REP_GAP_MS) return false;
        reps++;
        repTimes.add(ms);
        if (firstRepMs < 0) firstRepMs = ms;
        lastRepMs = ms;
        return true;
    }

    /** drop the last counted rep (counted by mistake); @return false if there is none */
    boolean undo() {
        if (reps == 0) return false;
        reps--;
        repTimes.remove(repTimes.size() - 1);
        lastRepMs = repTimes.isEmpty() ? -1 : repTimes.get(repTimes.size() - 1);
        firstRepMs = repTimes.isEmpty() ? -1 : repTimes.get(0);
        return true;
    }

    int reps() { return reps; }
    long lastRepMs() { return lastRepMs; }
    long firstRepMs() { return firstRepMs; }
    boolean isNearNow() { return near; }
    /** seconds from the first to the last counted rep (0 for one rep) */
    double activeSeconds() { return reps < 2 ? 0 : (lastRepMs - firstRepMs) / 1000.0; }

    /** write the counter into a live-session object (wall-clock stamps so it survives a process death) */
    org.json.JSONObject putSnapshot(org.json.JSONObject o, long nowWall, long nowMono) throws org.json.JSONException {
        o.put("reps", reps).put("near", near);
        if (lastRepMs >= 0) o.put("lastRepWall", nowWall - Math.max(0, nowMono - lastRepMs));
        if (firstRepMs >= 0) o.put("firstRepWall", nowWall - Math.max(0, nowMono - firstRepMs));
        org.json.JSONArray ages = new org.json.JSONArray();
        for (long t : repTimes) ages.put(nowWall - Math.max(0, nowMono - t));
        o.put("repWalls", ages);
        return o;
    }

    /** rebuild from {@link #putSnapshot}; elapsed-realtime stamps are shifted to `nowMono` from wall-clock ages */
    static PushupCounter fromSnapshot(org.json.JSONObject o, long nowWall, long nowMono) {
        PushupCounter c = new PushupCounter(o != null && o.optBoolean("near"), nowMono);
        if (o == null) return c;
        org.json.JSONArray walls = o.optJSONArray("repWalls");
        if (walls == null || walls.length() == 0) return c;
        for (int i = 0; i < walls.length(); i++) {
            long wall = walls.optLong(i);
            long t = nowMono - Math.max(0, nowWall - wall);
            c.repTimes.add(t);
        }
        c.reps = c.repTimes.size();
        c.firstRepMs = c.repTimes.get(0);
        c.lastRepMs = c.repTimes.get(c.reps - 1);
        return c;
    }
}
