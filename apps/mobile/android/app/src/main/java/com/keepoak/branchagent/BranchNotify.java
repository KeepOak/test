package com.keepoak.branchagent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Telling the owner when a task needs them. "When needed" checks only while the app is open (the
 * page does that); "on" also schedules a platform job every fifteen minutes. Nothing here uses
 * Google Play services, so the same build works from F-Droid.
 */
public class BranchNotify extends JobService {
    static final String CHANNEL = "branch-needs-you";
    private static final int JOB_ID = 4201;

    static void show(Context context, String id, String title, String body) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL,
                BranchWords.word(context, "phone.notify.channel", "Tasks that need you"), NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
        builder.setSmallIcon(R.mipmap.ic_launcher_foreground).setContentTitle(title).setContentText(body)
            .setColor(context.getColor(R.color.branch_accent)).setContentIntent(tap).setAutoCancel(true);
        manager.notify(id.hashCode(), builder.build());
    }

    /** Starts or stops the background check to match the "notifications" switch. */
    static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        if (!BranchWords.position(context, "notifications").equals("on")) {
            scheduler.cancel(JOB_ID);
            return;
        }
        scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, BranchNotify.class))
            .setPeriodic(15 * 60 * 1000L)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(false)
            .build());
    }

    /** Asks the paired Branch what is waiting and says so once for each new question. */
    static void check(Context context) {
        BranchVault vault = new BranchVault(context);
        JSONObject session = vault.load();
        if (session == null || BranchWords.position(context, "notifications").equals("off")) return;
        try {
            BranchClient.Answer answer = BranchClient.sendKept(vault, session, "GET", "/api/state", null, null, null, null);
            JSONArray waiting = answer.json instanceof JSONObject ? ((JSONObject) answer.json).optJSONArray("attention") : null;
            if (waiting == null) return;
            Set<String> told = new HashSet<>(BranchWords.state(context).getStringSet("told", new HashSet<>()));
            for (int i = 0; i < waiting.length(); i++) {
                JSONObject item = waiting.optJSONObject(i);
                String id = item == null ? "" : item.optString("runId", "");
                if (id.isEmpty() || !told.add(id)) continue;
                String question = item.optString("question", "");
                show(context, id, BranchWords.word(context, "phone.notify.title", "Branch needs you"),
                    question.length() > 180 ? question.substring(0, 180) : question);
            }
            BranchWords.state(context).edit().putStringSet("told", told).apply();
        } catch (Exception ignored) {
            // the computer may be asleep; the next check tries again
        }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            check(getApplicationContext());
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
