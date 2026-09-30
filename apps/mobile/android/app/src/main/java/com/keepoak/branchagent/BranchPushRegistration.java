package com.keepoak.branchagent;

import android.content.Context;
import org.json.JSONObject;

/** The paired phone registers only its own token. No Firebase dependency in non-push builds. */
final class BranchPushRegistration {
    private static final java.util.concurrent.atomic.AtomicBoolean busy = new java.util.concurrent.atomic.AtomicBoolean();
    private static volatile long attemptedAt = 0;
    static void sync(Context context) {
        BranchVault vault = new BranchVault(context);
        JSONObject session = vault.load();
        if (session == null) return;
        boolean enabled = !BranchWords.position(context, "push").equals("off");
        String token = BranchWords.state(context).getString("push-token", "");
        if (enabled && token.isEmpty()) return;
        if (enabled && System.currentTimeMillis() - attemptedAt < 60000) return;
        if (!busy.compareAndSet(false, true)) return;
        attemptedAt = System.currentTimeMillis();
        new Thread(() -> {
            try {
                JSONObject body = enabled ? new JSONObject().put("provider", "fcm").put("token", token).put("enabled", true) : new JSONObject();
                BranchClient.sendKept(vault, session, "POST", enabled ? "/api/mobile-push/register" : "/api/mobile-push/unregister", body, null, null, null);
            } catch (Exception ignored) { /* Retry when the switch or paired session is next read. */ }
            finally { busy.set(false); }
        }, "branch-push-registration").start();
    }

    static void forget(Context context, JSONObject session) {
        if (session == null) return;
        new Thread(() -> {
            try { BranchClient.send(session, "POST", "/api/mobile-push/unregister", new JSONObject(), null, null, null); }
            catch (Exception ignored) { /* Offline revocation is bounded by the registration lease. */ }
        }, "branch-push-unregister").start();
    }
}
