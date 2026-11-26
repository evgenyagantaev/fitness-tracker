package tech.agantay.fitness;

import static org.junit.Assert.*;

import org.junit.Test;

public class PushupGuardTest {
    @Test public void startsLocked() {
        PushupGuard g = new PushupGuard();
        assertFalse(g.isGuarding());
        g.start();
        assertTrue(g.isLocked() && g.isGuarding());
    }

    @Test public void volumeUnlocksOnceAndKeepsConsuming() {
        PushupGuard g = new PushupGuard();
        assertFalse(g.consumeVolume());          // off: let the system have the key
        g.start();
        assertTrue(g.consumeVolume());           // first press unlocks
        assertFalse(g.isLocked());
        assertEquals(PushupGuard.State.UNLOCKED, g.state());
        assertTrue(g.consumeVolume());           // later presses still swallowed, no toggle
        assertEquals(PushupGuard.State.UNLOCKED, g.state());
    }

    @Test public void stopReleasesKeys() {
        PushupGuard g = new PushupGuard();
        g.start();
        g.consumeVolume();
        g.stop();
        assertFalse(g.isGuarding());
        assertFalse(g.consumeVolume());
    }

    @Test public void restartLocksAgain() {
        PushupGuard g = new PushupGuard();
        g.start();
        g.consumeVolume();
        g.start();
        assertTrue(g.isLocked());
    }

    @Test public void volumeDoesNotFinishAnything() {
        // the guard has no "finish" action: a volume press only unlocks
        PushupGuard g = new PushupGuard();
        g.start();
        g.consumeVolume();
        assertTrue(g.isGuarding());
        assertFalse(g.isLocked());
    }
}
