package com.keepoak.branchagent;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.provider.Settings;
import android.content.ComponentName;
import android.os.Build;
import android.app.NotificationManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.UUID;

/** Never caches notification content or pushes it to Branch. Reads happen only for a foreground signed request. */
public final class BranchNotificationReader extends NotificationListenerService {
    private static volatile BranchNotificationReader connected;
    private static final LinkedHashMap<String, Ticket> tickets = new LinkedHashMap<>();
    private static final class Ticket {
        final String key, scope, identity, fingerprint;
        final long post, expires;
        Ticket(StatusBarNotification n, String scope, String identity) {
            key = n.getKey(); post = n.getPostTime(); this.scope = scope; this.identity = identity;
            fingerprint = fingerprint(n.getNotification());
            expires = System.currentTimeMillis() + 60000;
        }
    }
    @Override public void onListenerConnected() { connected = this; }
    @Override public void onListenerDisconnected() { connected = null; synchronized (tickets) { tickets.clear(); } }
    @Override public void onDestroy() { if (connected == this) connected = null; clearTickets(); super.onDestroy(); }
    static void clearTickets() { synchronized (tickets) { tickets.clear(); } }
    @Override public void onNotificationPosted(StatusBarNotification n) { invalidate(n.getKey()); }
    @Override public void onNotificationRemoved(StatusBarNotification n) { invalidate(n.getKey()); }
    private static void invalidate(String key) { synchronized (tickets) { tickets.values().removeIf(t -> t.key.equals(key)); } }

    static boolean allowed(Context context) {
        if (!BranchWords.state(context).getBoolean("notification-reader", false)) return false;
        ComponentName component = new ComponentName(context, BranchNotificationReader.class);
        if (Build.VERSION.SDK_INT >= 27) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            return manager != null && manager.isNotificationListenerAccessGranted(component);
        }
        String list = Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners");
        if (list == null) return false;
        for (String entry : list.split(":")) if (component.equals(ComponentName.unflattenFromString(entry))) return true;
        return false;
    }
    static JSONObject status(Context context) throws Exception {
        return new JSONObject().put("enabled", BranchWords.state(context).getBoolean("notification-reader", false))
            .put("access", allowed(context)).put("connected", connected != null);
    }
    private static BranchNotificationReader require(Context context) {
        BranchNotificationReader reader = connected;
        if (!allowed(context) || reader == null) throw new IllegalStateException("Enable Android notification access on this phone first.");
        return reader;
    }
    private static String bounded(CharSequence value, int limit) {
        String text = value == null ? "" : value.toString();
        // Suppress common verification-number content before it crosses the native bridge; Branch also leak-guards it.
        text = text.replaceAll("(?i)(?:otp|password|passcode|verification|security code).{0,80}", "[private]").replaceAll("\\b\\d{4,8}\\b", "[number]");
        return text.substring(0, Math.min(limit, text.length()));
    }
    private static Notification.Action reply(Notification n) {
        if (n.actions == null) return null;
        for (Notification.Action a : n.actions) if (a.actionIntent != null && a.getRemoteInputs() != null)
            for (RemoteInput input : a.getRemoteInputs()) if (input.getAllowFreeFormInput()) return a;
        return null;
    }
    private static String fingerprint(Notification n) {
        try {
            String state = String.valueOf(n.extras.getCharSequence(Notification.EXTRA_TITLE)) + "\n"
                + String.valueOf(n.extras.getCharSequence(Notification.EXTRA_TEXT)) + "\n"
                + String.valueOf(n.contentIntent) + "\n" + n.visibility + "\n" + n.category;
            if (n.actions != null) for (Notification.Action action : n.actions)
                state += "\n" + String.valueOf(action.title) + String.valueOf(action.actionIntent);
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(state.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP);
        } catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
    static JSONObject list(Context context, String app, boolean content, int limit, String scope, String identity) throws Exception {
        BranchNotificationReader reader = require(context);
        if (app.equals(context.getPackageName()) || !app.matches("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$") || app.length() > 160 || limit < 1 || limit > 10)
            throw new IllegalArgumentException("Name one exact app package and a limit up to ten.");
        JSONArray rows = new JSONArray();
        StatusBarNotification[] active = reader.getActiveNotifications();
        if (active == null) return new JSONObject().put("notifications", rows);
        for (StatusBarNotification sbn : active) {
            if (!app.equals(sbn.getPackageName()) || rows.length() >= limit) continue;
            Notification n = sbn.getNotification();
            if (n.visibility == Notification.VISIBILITY_SECRET || "authentication".equals(n.category)) continue;
            JSONObject row = new JSONObject().put("postedAt", sbn.getPostTime());
            JSONArray actions = new JSONArray();
            if (n.contentIntent != null) actions.put("open");
            if (sbn.isClearable()) actions.put("dismiss");
            if (reply(n) != null) actions.put("reply");
            if (scope.matches("^[a-f0-9-]{36}$")) {
                String id = UUID.randomUUID().toString();
                synchronized (tickets) {
                    tickets.values().removeIf(t -> t.expires <= System.currentTimeMillis());
                    if (tickets.size() < 100) { tickets.put(id, new Ticket(sbn, scope, identity)); row.put("id", id).put("actions", actions); }
                }
            }
            if (content) row.put("title", bounded(n.extras.getCharSequence(Notification.EXTRA_TITLE), 120))
                .put("text", bounded(n.extras.getCharSequence(Notification.EXTRA_TEXT), 500));
            rows.put(row);
        }
        return new JSONObject().put("notifications", rows);
    }
    static JSONObject action(Context context, String id, String scope, String identity, String action, String text) throws Exception {
        BranchNotificationReader reader = require(context);
        Ticket ticket; synchronized (tickets) { ticket = tickets.remove(id); }
        if (ticket == null || !ticket.scope.equals(scope) || !ticket.identity.equals(identity) || ticket.expires <= System.currentTimeMillis())
            throw new IllegalStateException("Refresh the notification; this action id expired or was revoked.");
        StatusBarNotification[] active = reader.getActiveNotifications(new String[] {ticket.key});
        if (active == null || active.length != 1 || active[0].getPostTime() != ticket.post) throw new IllegalStateException("The notification changed or was removed.");
        Notification n = active[0].getNotification();
        if (!ticket.fingerprint.equals(fingerprint(n))) throw new IllegalStateException("The notification changed; refresh it first.");
        if (n.visibility == Notification.VISIBILITY_SECRET || "authentication".equals(n.category)) throw new IllegalStateException("That notification is private.");
        if (action.equals("dismiss") && active[0].isClearable()) reader.cancelNotification(ticket.key);
        else if (action.equals("open") && n.contentIntent != null) n.contentIntent.send();
        else if (action.equals("reply")) sendReply(context, n, text);
        else throw new IllegalStateException("That exact action is unavailable.");
        return new JSONObject().put("requested", action);
    }
    private static void sendReply(Context context, Notification n, String text) throws PendingIntent.CanceledException {
        Notification.Action action = reply(n);
        if (action == null || text.trim().isEmpty() || text.length() > 500) throw new IllegalArgumentException("Give the exact bounded reply text.");
        Bundle values = new Bundle();
        for (RemoteInput input : action.getRemoteInputs()) if (input.getAllowFreeFormInput()) values.putCharSequence(input.getResultKey(), text);
        Intent fill = new Intent(); RemoteInput.addResultsToIntent(action.getRemoteInputs(), fill, values);
        action.actionIntent.send(context, 0, fill);
    }
}
