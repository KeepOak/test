package com.keepoak.branchagent;

import android.app.Activity;
import android.appwidget.*;
import android.content.Intent;
import android.os.Bundle;
import android.widget.*;
import org.json.*;

/** Platform-owned addition flow. Cancel leaves the widget unconfigured and grants nothing. */
public final class BranchWidgetConfigure extends Activity {
    private int widgetId;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); setResult(RESULT_CANCELED);
        widgetId=getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,AppWidgetManager.INVALID_APPWIDGET_ID);
        AppWidgetProviderInfo info=AppWidgetManager.getInstance(this).getAppWidgetInfo(widgetId);
        if(info==null || !getPackageName().equals(info.provider.getPackageName()) || BranchTrunkWidget.ids(this).length>8) { finish(); return; }
        boolean many=info.provider.getClassName().equals(BranchTrunksWidget.class.getName());
        TextView loading=new TextView(this); loading.setText("Unlock and pair Branch first. Reading Trunk choices…"); setContentView(loading);
        new Thread(() -> { try { JSONObject data=BranchTrunkWidget.projection(this); runOnUiThread(() -> choices(data,many)); }
            catch(Exception error) { runOnUiThread(() -> loading.setText("Unlock the owner profile and pair this phone, then add the widget again.")); }
        },"Branch-widget-config").start();
    }
    private void choices(JSONObject data, boolean many) {
        if(isFinishing()) return;
        try {
            LinearLayout layout=new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(24,24,24,24);
            TextView note=new TextView(this); note.setText("Show selected Trunk names, pebble faces and last-known status on this phone home screen. No task text or actions. Select "+(many?"up to four":"one")+". Refresh is read-only."); layout.addView(note);
            JSONArray trunks=data.getJSONArray("trunks"); java.util.ArrayList<CheckBox> picks=new java.util.ArrayList<>();
            for(int i=0;i<trunks.length() && i<20;i++) { JSONObject trunk=trunks.getJSONObject(i); CheckBox box=new CheckBox(this); box.setText(trunk.optString("name")); box.setTag(trunk.optString("id")); picks.add(box); layout.addView(box); }
            Button save=new Button(this); save.setText("Allow selected metadata on home screen"); layout.addView(save);
            save.setOnClickListener(view -> { try {
                JSONArray selected=new JSONArray(); for(CheckBox box:picks) if(box.isChecked()) selected.put(box.getTag().toString());
                if(selected.length()<1 || selected.length()>(many?4:1)) { note.setText("Select "+(many?"one to four":"exactly one")+" Trunks."); return; }
                save.setEnabled(false); confirm(data,selected);
            } catch(Exception error) { finish(); }});
            ScrollView scroll=new ScrollView(this); scroll.addView(layout); setContentView(scroll);
        } catch(Exception error) { finish(); }
    }
    private void confirm(JSONObject old, JSONArray selected) {
        new Thread(() -> { try {
            JSONObject fresh=BranchTrunkWidget.projection(this),session=new BranchVault(this).load();
            if(session==null || !fresh.getString("profileId").equals(old.getString("profileId"))
                || !fresh.getString("_identity").equals(old.getString("_identity"))
                || !BranchTrunkWidget.identity(session).equals(fresh.getString("_identity"))) throw new SecurityException("Pairing/profile changed.");
            JSONObject config=new JSONObject().put("identity",BranchTrunkWidget.identity(session)).put("profile",fresh.getString("profileId")).put("selected",selected);
            if(isFinishing()) return;
            BranchTrunkWidget.prefs(this).edit().putString("config-"+widgetId,config.toString()).apply();
            BranchTrunkWidget.render(this,widgetId,config,fresh); BranchTrunkWidget.expire(this);
            runOnUiThread(() -> { setResult(RESULT_OK,new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,widgetId)); finish(); });
        } catch(Exception error) { runOnUiThread(this::finish); } },"Branch-widget-confirm").start();
    }
}
