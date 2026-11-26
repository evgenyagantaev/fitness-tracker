package tech.agantay.fitness;

/**
 * v1.12: touch-lock state during a push-up set.
 * LOCKED: the screen ignores touches; a volume key unlocks (and is always swallowed, so it never changes media volume).
 * UNLOCKED: on-screen controls work; volume keys are still swallowed until the guard is stopped.
 * The set itself is not finished by a volume press.
 */
public class PushupGuard {
    public enum State { OFF, LOCKED, UNLOCKED }

    private State state = State.OFF;

    public State state() { return state; }
    public boolean isGuarding() { return state != State.OFF; }
    public boolean isLocked() { return state == State.LOCKED; }

    /** Start (or restart) a set: the screen is locked. */
    public void start() { state = State.LOCKED; }

    /** Volume / mute key. Returns true if the event must be consumed (no volume change). */
    public boolean consumeVolume() {
        if (state == State.OFF) return false;
        if (state == State.LOCKED) state = State.UNLOCKED;
        return true;
    }

    public void stop() { state = State.OFF; }
}
