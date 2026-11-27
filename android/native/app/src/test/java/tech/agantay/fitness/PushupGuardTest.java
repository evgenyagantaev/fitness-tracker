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

    @Test public void restoredSetOpensUnlockedAndLongTouchFailsafeUnlocks() {
        PushupGuard g = new PushupGuard();
        g.startUnlocked();
        assertTrue(g.isGuarding()); assertFalse(g.isLocked());
        assertFalse("nothing to force", g.forceUnlock());
        g.start();
        assertTrue(g.isLocked());
        assertTrue("3 s touch failsafe releases the lock", g.forceUnlock());
        assertFalse(g.isLocked()); assertTrue(g.isGuarding());
        assertEquals("unlocked", g.name());
        g.stop(); assertEquals("off", g.name());
    }
}
