package tech.agantay.fitness;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * v1.17: keeps the app in the foreground while a pull-up set runs, so the accelerometer keeps delivering with the screen
 * off / phone in a pocket. All the counting is in {@link PullupSession}; this only shows "Подтягивания: N".
 * "cmd" = "finish" (notification button) ends the set.
 */
public class PullupService extends Service {
    static final String TAG = "PullupService", CHANNEL = "pullups";
    static final int NOTIF_ID = 4217;

    static void start(Context c) {
        try { ContextCompat.startForegroundService(c, new Intent(c, PullupService.class)); }
        catch (Exception e) { Log.w(TAG, "start", e); }
    }
    static void stop(Context c) { try { c.stopService(new Intent(c, PullupService.class)); } catch (Exception ignored) {} }
    static void update(Context c) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && PullupSession.get(c).active()) nm.notify(NOTIF_ID, build(c));
        } catch (Exception ignored) {}
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "finish".equals(intent.getStringExtra("cmd"))) {
            PullupSession.get(this).finishAsync("button");
            return START_NOT_STICKY;
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Подтягивания", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification n = build(this);
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                int t = ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED
                    ? ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH : 0;
                if (t != 0) startForeground(NOTIF_ID, n, t); else startForeground(NOTIF_ID, n);
            } else startForeground(NOTIF_ID, n);
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed", e);
            try { startForeground(NOTIF_ID, n); } catch (Exception e2) { Log.w(TAG, "startForeground plain failed", e2); }
        }
        if (!PullupSession.get(this).active()) { stopSelf(); return START_NOT_STICKY; }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        try { stopForeground(true); } catch (Exception ignored) {}
        super.onDestroy();
    }

    static Notification build(Context c) {
        PullupSession s = PullupSession.get(c);
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 11, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent fin = PendingIntent.getService(c, 12, new Intent(c, PullupService.class).putExtra("cmd", "finish"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = s.countdownLeft() > 0 ? "Подтягивания: старт через " + s.countdownLeft() + " с" : "Подтягивания: " + s.reps();
        return new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(title)
            .setContentText("Счёт по акселерометру. Подход закроется сам через 6 с без повторов.")
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_WORKOUT)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(pi)
            .addAction(0, "Закончить подход", fin)
            .build();
    }
}
