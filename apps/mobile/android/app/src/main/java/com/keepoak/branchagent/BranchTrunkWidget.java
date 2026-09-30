package com.keepoak.branchagent;

import android.app.*;
import android.appwidget.*;
import android.content.*;
import android.graphics.*;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import org.json.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Read-only home-screen metadata, configured explicitly; never keeps tokens or notification content. */
public class BranchTrunkWidget extends AppWidgetProvider {
    private static final AtomicBoolean reading = new AtomicBoolean();
    private static volatile long lastRead=-30000;
    static final String REFRESH = "com.keepoak.branchagent.WIDGET_REFRESH", CLEAR = "com.keepoak.branchagent.WIDGET_CLEAR";
    static android.content.SharedPreferences prefs(Context c) { return c.getSharedPreferences("branch-widgets", Context.MODE_PRIVATE); }
    static String identity(JSONObject session) { return session.optString("origin") + "/" + session.optString("deviceId") + "/" + session.optString("pairedAt"); }
    static int[] ids(Context c) {
        AppWidgetManager manager = AppWidgetManager.getInstance(c);
        int[] one = manager.getAppWidgetIds(new ComponentName(c, BranchTrunkWidget.class));
        int[] many = manager.getAppWidgetIds(new ComponentName(c, BranchTrunksWidget.class));
        int[] all = java.util.Arrays.copyOf(one, one.length + many.length); System.arraycopy(many, 0, all, one.length, many.length); return all;
    }
    static JSONObject projection(Context c) throws Exception {
        KeyguardManager guard = (KeyguardManager)c.getSystemService(Context.KEYGUARD_SERVICE);
        if (guard == null || guard.isDeviceLocked()) throw new SecurityException("Unlock this phone.");
        JSONObject session = new BranchVault(c).load();
        if (session == null || !session.has("deviceId") || !session.has("deviceKey")) throw new SecurityException("Pair this phone again.");
        BranchClient.Answer answer = BranchClient.send(session, "GET", "/api/phone/widgets", null, null, null, null);
        if (answer.status != 200 || !(answer.json instanceof JSONObject)) throw new SecurityException("Owner profile unavailable.");
        return ((JSONObject)answer.json).put("_identity", identity(session));
    }
    static void empty(Context c, int id, String message) {
        RemoteViews views = new RemoteViews(c.getPackageName(), R.layout.branch_trunk_widget);
        views.setTextViewText(R.id.widget_note, message);
        for (int row : new int[]{R.id.widget_row1,R.id.widget_row2,R.id.widget_row3,R.id.widget_row4}) views.setViewVisibility(row, View.GONE);
        views.setOnClickPendingIntent(R.id.widget_refresh, refreshIntent(c, id));
        AppWidgetManager.getInstance(c).updateAppWidget(id, views);
    }
    static void clear(Context c) { for (int id : ids(c)) empty(c, id, "Open Branch and refresh. No current status."); }
    static PendingIntent refreshIntent(Context c, int id) {
        Intent intent = new Intent(c, BranchTrunkWidget.class).setAction(REFRESH).setData(Uri.parse("branch-widget://refresh/"+id));
        return PendingIntent.getBroadcast(c, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    @Override public void onReceive(Context context, Intent intent) {
        if (CLEAR.equals(intent.getAction())) { clear(context); return; }
        if (REFRESH.equals(intent.getAction())) { refresh(context); return; }
        super.onReceive(context, intent);
    }
    @Override public void onUpdate(Context c, AppWidgetManager manager, int[] ids) { refresh(c); }
    @Override public void onDeleted(Context c, int[] ids) { for (int id : ids) prefs(c).edit().remove("config-"+id).apply(); }
    private void refresh(Context context) {
        Context c = context.getApplicationContext();
        if(prefs(c).getAll().keySet().stream().noneMatch(key -> key.startsWith("config-"))) { clear(c); return; }
        if (!reading.compareAndSet(false, true)) return;
        long now=android.os.SystemClock.elapsedRealtime();
        if(now-lastRead<30000) { reading.set(false); return; } lastRead=now;
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                clear(c); JSONObject data = projection(c), session = new BranchVault(c).load();
                if (session == null || !identity(session).equals(data.optString("_identity"))) return;
                for (int id : ids(c)) {
                    String packed = prefs(c).getString("config-"+id, null);
                    if (packed == null) continue;
                    JSONObject config = new JSONObject(packed);
                    if (!identity(session).equals(config.optString("identity")) || !data.optString("profileId").equals(config.optString("profile"))) {
                        prefs(c).edit().remove("config-"+id).apply(); continue;
                    }
                    render(c, id, config, data);
                }
                expire(c);
            } catch (Exception error) { clear(c); }
            finally { reading.set(false); pending.finish(); }
        }, "Branch-widget-status").start();
    }
    static void render(Context c, int id, JSONObject config, JSONObject data) throws Exception {
        JSONObject current=new BranchVault(c).load(); KeyguardManager guard=(KeyguardManager)c.getSystemService(Context.KEYGUARD_SERVICE);
        if(current==null || guard==null || guard.isDeviceLocked() || !identity(current).equals(config.getString("identity"))) {
            empty(c,id,"Phone locked or pairing changed. Refresh after unlocking."); return;
        }
        RemoteViews views = new RemoteViews(c.getPackageName(), R.layout.branch_trunk_widget);
        int[] rows={R.id.widget_row1,R.id.widget_row2,R.id.widget_row3,R.id.widget_row4};
        int[] texts={R.id.widget_text1,R.id.widget_text2,R.id.widget_text3,R.id.widget_text4};
        int[] faces={R.id.widget_face1,R.id.widget_face2,R.id.widget_face3,R.id.widget_face4};
        JSONArray selected = config.getJSONArray("selected"), trunks = data.getJSONArray("trunks");
        int shown = 0;
        for (int i=0; i<selected.length() && shown<4; i++) for (int j=0; j<trunks.length(); j++) {
            JSONObject trunk = trunks.getJSONObject(j);
            if (!selected.getString(i).equals(trunk.optString("id"))) continue;
            String chat = trunk.optString("sessionId"); if (!chat.matches("^[a-f0-9-]{36}$")) continue;
            views.setViewVisibility(rows[shown], View.VISIBLE);
            String name = trunk.optString("name"); views.setTextViewText(texts[shown], name.substring(0,Math.min(40,name.length()))+" · "+trunk.optString("status"));
            views.setImageViewBitmap(faces[shown], face(trunk));
            Intent open = new Intent(c, MainActivity.class).setAction("android.intent.action.VIEW")
                .setData(Uri.parse("branch-widget://chat/"+chat)).putExtra("branch-widget-id",id).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            views.setOnClickPendingIntent(rows[shown], PendingIntent.getActivity(c, id*4+shown, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)); shown++;
        }
        for (int i=shown;i<4;i++) views.setViewVisibility(rows[i],View.GONE);
        views.setTextViewText(R.id.widget_note, "Last checked " + android.text.format.DateFormat.format("HH:mm", System.currentTimeMillis()) + ". Refresh for current status.");
        views.setOnClickPendingIntent(R.id.widget_refresh, refreshIntent(c,id));
        AppWidgetManager.getInstance(c).updateAppWidget(id, views);
    }
    private static Bitmap face(JSONObject trunk) {
        Bitmap bitmap=Bitmap.createBitmap(80,80,Bitmap.Config.ARGB_8888); Canvas canvas=new Canvas(bitmap); Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        String colour=trunk.optString("colour"); paint.setColor(colour.matches("^#[a-fA-F0-9]{6}$")?Color.parseColor(colour):0xff376a50);
        canvas.drawCircle(40,40,36,paint); paint.setColor(Color.WHITE);
        if ("sleepy".equals(trunk.optString("eyes"))) { paint.setStrokeWidth(4); canvas.drawLine(22,37,32,37,paint); canvas.drawLine(48,37,58,37,paint); }
        else { float radius="wide".equals(trunk.optString("eyes"))?7:4; canvas.drawCircle(27,37,radius,paint); canvas.drawCircle(53,37,radius,paint); }
        return bitmap;
    }
    static void expire(Context c) {
        Intent intent=new Intent(c,BranchTrunkWidget.class).setAction(CLEAR);
        PendingIntent pending=PendingIntent.getBroadcast(c,0,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        ((AlarmManager)c.getSystemService(Context.ALARM_SERVICE)).setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,android.os.SystemClock.elapsedRealtime()+60000,pending);
    }
}
