package com.keepoak.branchagent;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Push, built only with -PbranchPush and a google-services.json from the owner's own Firebase
 * project (docs/configuration.md, "Phone apps"). A message carries no secret: it only says a task
 * needs the owner, and the phone shows it while the "push" switch is not off.
 */
public class BranchPushService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        BranchWords.state(this).edit().putString("push-token", token).apply();
        BranchPushRegistration.sync(this);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        if (BranchWords.position(this, "push").equals("off")) return;
        String body = message.getData().containsKey("question") ? message.getData().get("question") : "";
        BranchNotify.show(this, message.getMessageId() == null ? "push" : message.getMessageId(),
            "finished".equals(message.getData().get("kind")) ? "Branch finished" : BranchWords.word(this, "phone.notify.title", "Branch needs you"), body);
    }
}
