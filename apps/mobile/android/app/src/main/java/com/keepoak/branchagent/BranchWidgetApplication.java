package com.keepoak.branchagent;
import android.app.Application;
import android.content.*;
import android.os.Build;
/** No cached content survives process restart; clear displayed metadata as soon as screen-off is observed. */
public final class BranchWidgetApplication extends Application {
    @Override public void onCreate() {
        super.onCreate(); BranchTrunkWidget.clear(this);
        BroadcastReceiver receiver=new BroadcastReceiver() { @Override public void onReceive(Context c, Intent intent) { BranchTrunkWidget.clear(c); } };
        IntentFilter filter=new IntentFilter(Intent.ACTION_SCREEN_OFF);
        if(Build.VERSION.SDK_INT>=33) registerReceiver(receiver,filter,Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(receiver,filter);
    }
}
