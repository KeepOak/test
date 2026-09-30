package com.keepoak.branchagent;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.Locale;
import java.util.function.BooleanSupplier;

/** Open only a public listing, using the installed app's own session. No session or token is inspected. */
final class BranchAppLinks {
    private static boolean asking;
    private static final class Target {
        final String name, kind, host, path, packageName;
        final String[] hosts;
        Target(String name, String kind, String[] hosts, String host, String path, String packageName) {
            this.name = name; this.kind = kind; this.hosts = hosts; this.host = host; this.path = path; this.packageName = packageName;
        }
    }
    private static final Target[] TARGETS = {
        new Target("Airbnb", "listing", new String[] {"airbnb.com", "www.airbnb.com"}, "www.airbnb.com", "/rooms/[0-9]{1,20}/?", "com.airbnb.android"),
        new Target("Spotify", "track", new String[] {"open.spotify.com"}, "open.spotify.com", "/track/[A-Za-z0-9]{22}/?", "com.spotify.music")
    };
    private static final class Link {
        final Uri url; final Target target;
        Link(Uri url, Target target) { this.url = url; this.target = target; }
    }
    private static Link listing(String value) {
        if (value == null || value.length() > 4096) return null;
        Uri url = Uri.parse(value);
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
        String path = url.getEncodedPath();
        if (!"https".equals(url.getScheme()) || url.getUserInfo() != null || (url.getPort() != -1 && url.getPort() != 443)) return null;
        if (path == null) return null;
        for (Target target : TARGETS) if (java.util.Arrays.asList(target.hosts).contains(host) && path.matches(target.path))
            return new Link(Uri.parse("https://" + target.host + path.replaceAll("/$", "")), target);
        return null;
    }
    static void open(Activity activity, PluginCall call, BooleanSupplier ownPage) {
        Link link = listing(call.getString("url"));
        if (link == null) { call.reject("Only a supported HTTPS app link can open here"); return; }
        activity.runOnUiThread(() -> {
            if (!ownPage.getAsBoolean() || activity.isFinishing()) { call.reject("Only the phone app may open a listing"); return; }
            if (asking) { call.reject("Answer the open-listing question first"); return; }
            asking = true;
            new AlertDialog.Builder(activity).setTitle("Open " + link.target.name + " " + link.target.kind + "?")
                .setMessage(link.url + "\nThe app keeps its own sign-in. If it is unavailable, your browser opens.")
                .setNegativeButton("Cancel", (_dialog, _which) -> call.resolve(result(false, "cancelled")))
                .setPositiveButton("Open " + link.target.kind, (_dialog, _which) -> {
                    if (!ownPage.getAsBoolean()) { call.reject("The phone app is no longer showing"); return; }
                    dispatch(activity, call, link);
                })
                .setOnCancelListener(_dialog -> call.resolve(result(false, "cancelled")))
                .setOnDismissListener(_dialog -> asking = false).show();
        });
    }
    private static void dispatch(Activity activity, PluginCall call, Link link) {
        Intent app = new Intent(Intent.ACTION_VIEW, link.url).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(link.target.packageName);
        try { activity.startActivity(app); call.resolve(result(true, "app")); }
        catch (ActivityNotFoundException | SecurityException unavailable) {
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, link.url).addCategory(Intent.CATEGORY_BROWSABLE));
                call.resolve(result(true, "system"));
            } catch (ActivityNotFoundException | SecurityException error) { call.reject("No app or browser could open this listing"); }
        }
    }
    private static JSObject result(boolean opened, String destination) {
        JSObject answer = new JSObject(); answer.put("opened", opened); answer.put("destination", destination); return answer;
    }
}
