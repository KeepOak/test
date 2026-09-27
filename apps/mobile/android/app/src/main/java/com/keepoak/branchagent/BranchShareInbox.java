package com.keepoak.branchagent;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * What other apps shared with "Send to Branch". The share target is an activity alias that ships
 * switched off (AndroidManifest.xml); the "share" switch turns it on. Items wait here, in memory
 * only, until the phone app's page shows them and the owner sends them.
 */
final class BranchShareInbox {
    private static final long MAX_BYTES = 20L * 1024 * 1024;
    private static JSArray waiting = new JSArray();

    private BranchShareInbox() {}

    static void applySwitch(Context context) {
        boolean on = !BranchWords.position(context, "share").equals("off");
        context.getPackageManager().setComponentEnabledSetting(
            BranchComponents.component(context, ".ShareTarget"),
            on ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP);
    }

    static synchronized JSArray take() {
        JSArray out = waiting;
        waiting = new JSArray();
        return out;
    }

    /** Reads a SEND or SEND_MULTIPLE intent. Answers true when it was one. */
    static synchronized boolean accept(Context context, Intent intent) {
        if (intent == null || !(Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()))) return false;
        if (BranchWords.position(context, "share").equals("off")) return false;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text != null && text.length() > 0) waiting.put(item("text", text.toString()));
        for (Uri uri : streams(intent)) {
            JSObject file = readFile(context.getContentResolver(), uri);
            if (file != null) waiting.put(file);
        }
        return true;
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> streams(Intent intent) {
        List<Uri> out = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) out.addAll(many);
        } else {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) out.add(one);
        }
        return out;
    }

    private static JSObject item(String kind, String text) {
        JSObject out = new JSObject();
        out.put("kind", kind);
        out.put("text", text);
        return out;
    }

    private static JSObject readFile(ContentResolver resolver, Uri uri) {
        String name = "Shared file";
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
        } catch (Exception ignored) {
            // keep the plain name
        }
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[65536];
            for (int n; (n = in.read(buffer)) > 0; ) {
                bytes.write(buffer, 0, n);
                if (bytes.size() > MAX_BYTES) return null;
            }
            JSObject out = new JSObject();
            out.put("kind", "file");
            out.put("name", name);
            out.put("type", resolver.getType(uri) == null ? "application/octet-stream" : resolver.getType(uri));
            out.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
            return out;
        } catch (Exception error) {
            return null;
        }
    }
}
