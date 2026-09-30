package com.keepoak.branchagent;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BranchPhonePlugin.class);
        super.onCreate(savedInstanceState);
        takeWidget(getIntent());
        takeShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        takeWidget(intent);
        takeShare(intent);
    }
    private void takeWidget(Intent intent) {
        android.net.Uri uri=intent.getData();
        if(uri==null || !"branch-widget".equals(uri.getScheme()) || !"chat".equals(uri.getHost())) return;
        String chat=uri.getLastPathSegment(); int widget=intent.getIntExtra("branch-widget-id",-1);
        if(chat==null || !chat.matches("^[a-f0-9-]{36}$") || widget<0) return;
        BranchWords.state(this).edit().putString("widget-chat",chat).putInt("widget-id",widget).apply();
        if(bridge!=null) bridge.triggerDocumentJSEvent("branch-widget");
    }

    /** Something was shared in: show the phone app's own page, which offers to send it. */
    private void takeShare(Intent intent) {
        if (!BranchShareInbox.accept(this, intent) || bridge == null) return;
        String here = String.valueOf(bridge.getWebView().getUrl());
        if (here.startsWith(bridge.getAppUrl())) bridge.triggerDocumentJSEvent("branch-shared");
        else bridge.getWebView().loadUrl(bridge.getAppUrl());
    }

    /** When the app was last on screen, for the "lock when needed" switch. */
    @Override
    public void onPause() {
        super.onPause();
        BranchWords.state(this).edit().putLong("last-seen", System.currentTimeMillis()).apply();
    }
}
