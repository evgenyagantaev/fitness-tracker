package tech.agantay.fitness;

import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;

import com.getcapacitor.BridgeActivity;

/**
 * Host activity. While a push-up set is guarded, a transparent shield sits on top of the WebView
 * (all touches are swallowed), the navigation and status bars are hidden, Back is ignored,
 * and volume keys never change the media volume. A volume press unlocks the shield so the
 * on-screen «Закончить» / «−1» buttons work. Home, Recents and the notification shade cannot
 * be fully blocked without screen pinning (which would show a system dialog mid-set).
 */
public class MainActivity extends BridgeActivity {
    private final PushupGuard pushupGuard = new PushupGuard();
    private View shield;
    private int savedUi;
    private boolean savedDecorFits = true;
    private Runnable onUnlocked;
    private java.util.function.BooleanSupplier sessionProbe;
    private long guardSince = 0;
    private final android.os.Handler uiHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable holdUnlock = this::unlockFromTouch;
    /** a guard with no push-up session behind it (and no countdown) for this long is a leftover: release it */
    static final long GUARD_ORPHAN_MS = 15_000;
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            if (!pushupGuard.isGuarding()) return;
            boolean alive = sessionProbe != null && sessionProbe.getAsBoolean();
            if (!alive && android.os.SystemClock.elapsedRealtime() - guardSince > GUARD_ORPHAN_MS) {
                setPushupGuard(false, false);
                return;
            }
            uiHandler.postDelayed(this, 2000);
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StepCounterPlugin.class);   // local plugins, must be registered before super.onCreate
        registerPlugin(WorkoutRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }

    public void setOnPushupUnlocked(Runnable r) { onUnlocked = r; }
    /** true while a native push-up session exists (counting or paused) */
    public void setSessionProbe(java.util.function.BooleanSupplier p) { sessionProbe = p; }
    public String guardState() { return pushupGuard.name(); }

    public void setPushupGuard(boolean on) { setPushupGuard(on, true); }

    /** @param locked with `on`: start LOCKED (a fresh set, a return from Recents) or UNLOCKED (a set restored after the app was killed) */
    public void setPushupGuard(boolean on, boolean locked) {
        uiHandler.removeCallbacks(holdUnlock);
        uiHandler.removeCallbacks(watchdog);
        if (on) {
            guardSince = android.os.SystemClock.elapsedRealtime();
            if (locked) { pushupGuard.start(); addShield(); } else { pushupGuard.startUnlocked(); removeShield(); }
            enterImmersive();
            uiHandler.postDelayed(watchdog, 2000);
        } else {
            pushupGuard.stop();
            removeShield();
            exitImmersive();
        }
    }

    /** the 3-second touch failsafe: the volume keys may be dead on some ROMs */
    private void unlockFromTouch() {
        if (pushupGuard.forceUnlock()) {
            removeShield();
            if (onUnlocked != null) onUnlocked.run();
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int k = event.getKeyCode();
        boolean volume = k == KeyEvent.KEYCODE_VOLUME_DOWN || k == KeyEvent.KEYCODE_VOLUME_UP
                || k == KeyEvent.KEYCODE_VOLUME_MUTE || k == KeyEvent.KEYCODE_MUTE;
        if (volume && pushupGuard.isGuarding()) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                boolean wasLocked = pushupGuard.isLocked();
                pushupGuard.consumeVolume();
                if (wasLocked && !pushupGuard.isLocked()) {
                    removeShield();
                    if (onUnlocked != null) onUnlocked.run();
                }
            }
            return true;   // never change media volume while the set is on screen
        }
        if (pushupGuard.isGuarding() && (k == KeyEvent.KEYCODE_BACK || k == KeyEvent.KEYCODE_ESCAPE)) {
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (pushupGuard.isGuarding()) return;
        super.onBackPressed();
    }

    private void addShield() {
        if (shield != null) return;
        FrameLayout s = new FrameLayout(this);
        s.setClickable(true);
        s.setFocusable(false);
        s.setBackgroundColor(0x00000000);
        s.setOnTouchListener((v, e) -> {
            int a = e.getActionMasked();
            if (a == android.view.MotionEvent.ACTION_DOWN) { uiHandler.removeCallbacks(holdUnlock); uiHandler.postDelayed(holdUnlock, 3000); }
            else if (a == android.view.MotionEvent.ACTION_UP || a == android.view.MotionEvent.ACTION_CANCEL) uiHandler.removeCallbacks(holdUnlock);
            return true;
        });
        s.setElevation(10000f);
        addContentView(s, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        shield = s;
    }

    private void removeShield() {
        if (shield == null) return;
        try {
            android.view.ViewParent p = shield.getParent();
            if (p instanceof android.view.ViewGroup) ((android.view.ViewGroup) p).removeView(shield);
        } catch (Exception ignored) {}
        shield = null;
    }

    @SuppressWarnings("deprecation")
    private void enterImmersive() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                getWindow().setDecorFitsSystemWindows(false);
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) {
                    c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                View d = getWindow().getDecorView();
                savedUi = d.getSystemUiVisibility();
                d.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            }
        } catch (Exception ignored) {}
    }

    @SuppressWarnings("deprecation")
    private void exitImmersive() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                getWindow().setDecorFitsSystemWindows(savedDecorFits);
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) {
                    c.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                }
            } else {
                getWindow().getDecorView().setSystemUiVisibility(savedUi);
            }
        } catch (Exception ignored) {}
    }
}
