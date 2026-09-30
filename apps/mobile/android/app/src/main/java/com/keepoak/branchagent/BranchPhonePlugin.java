package com.keepoak.branchagent;

import android.Manifest;
import android.app.KeyguardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.os.Build;
import android.os.CancellationSignal;
import android.webkit.PermissionRequest;
import android.webkit.GeolocationPermissions;
import android.app.NotificationManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import org.json.JSONObject;

/**
 * The phone app's page talks to the phone through this plugin only (apps/mobile/web/vault.js). The
 * key a Branch hands over stays here and in the Keystore-sealed vault; this page never receives it
 * (opening the owner's Branch hands it to that address's own session storage: see BranchWeb).
 */
@CapacitorPlugin(name = "BranchPhone", permissions = { @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }) })
public class BranchPhonePlugin extends Plugin {
    private BranchVault vault;
    private BranchNode node; // mac7/phone-pairing
    private BranchLend lend; // PH-03
    private volatile boolean foreground;

    @Override
    public void load() {
        vault = new BranchVault(getContext());
        node = new BranchNode(getContext());
        lend = new BranchLend(node, new BranchLend.Page() {
            @Override
            public boolean showing() {
                return appPageShowing();
            }

            @Override
            public boolean foreground() { return foreground; }

            @Override
            public void state(long generation, boolean connected, java.util.List<String> enabled) {
                JSObject out = new JSObject();
                out.put("generation", generation);
                out.put("connected", connected);
                out.put("enabled", new org.json.JSONArray(enabled));
                getActivity().runOnUiThread(() -> lend.deliver(generation, () -> notifyListeners("lendState", out)));
            }

            @Override
            public void invoke(JSONObject ask) {
                try {
                    JSObject out = JSObject.fromJSONObject(ask);
                    long generation = ask.optLong("generation", -1);
                    getActivity().runOnUiThread(() -> lend.deliver(generation, () -> {
                        if (foreground) notifyListeners("lendInvoke", out);
                    }));
                } catch (org.json.JSONException ignored) {
                    // made from a JSONObject just above; it always converts
                }
            }
        });
        guardMedia();
        BranchWeb.install(getBridge(), vault.load());
        BranchShareInbox.applySwitch(getContext());
    }

    /**
     * mac7/phone-pairing review: Capacitor's own web view client grants the camera and the microphone
     * to any page that asks, and the owner's Branch opens in this same web view. The phone's "never
     * allow" list is checked here first, so a ticked refusal holds whatever Branch's page asks for.
     */
    private void guardMedia() {
        getBridge().getWebView().setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                boolean ownPage = foreground && BranchRefusals.sameOrigin(String.valueOf(request.getOrigin()), getBridge().getAppUrl());
                if (!BranchRefusals.mayCapture(node.never(), request.getResources(), ownPage)) {
                    request.deny();
                    return;
                }
                super.onPermissionRequest(request);
            }
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!foreground || !BranchRefusals.sameOrigin(origin, getBridge().getAppUrl()) || node.never().contains("location")) {
                    callback.invoke(origin, false, false); return;
                }
                super.onGeolocationPermissionsShowPrompt(origin, (from, allowed, remember) -> callback.invoke(from,
                    allowed && foreground && !node.never().contains("location")
                        && BranchRefusals.sameOrigin(String.valueOf(getBridge().getWebView().getUrl()), getBridge().getAppUrl()), false));
            }
        });
    }

    @PluginMethod
    public void pair(PluginCall call) {
        String origin = BranchRules.checkOrigin(call.getString("origin", ""));
        if (origin == null) {
            call.resolve(result("paired", false).put("error", BranchWords.word(getContext(), "phone.error.plainHttp", "That address is refused.")));
            return;
        }
        getBridge().execute(() -> {
            try {
                JSONObject body = new JSONObject().put("id", call.getString("id", "")).put("code", call.getString("code", ""))
                    .put("name", call.getString("name", Build.MODEL));
                BranchClient.Answer answer = BranchClient.pair(origin, body);
                JSONObject json = answer.json instanceof JSONObject ? (JSONObject) answer.json : new JSONObject();
                if (answer.status != 200 || !json.has("token")) {
                    call.resolve(result("paired", false).put("error", json.optString("error",
                        BranchWords.word(getContext(), "phone.error.pairFailed", "That did not work."))));
                    return;
                }
                JSONObject session = new JSONObject().put("origin", origin).put("token", json.getString("token"))
                    .put("pairedAt", BranchClock.now());
                if (json.has("deviceId")) session.put("deviceId", json.getString("deviceId")).put("deviceKey", json.getString("deviceKey"));
                vault.save(session);
                call.resolve(result("paired", true));
                restartWindow();
            } catch (Exception error) {
                call.resolve(result("paired", false).put("error", String.valueOf(error.getMessage())));
            }
        });
    }

    /**
     * The page script and its message channel are set up only while the window is being made
     * (load()): adding them to a web view that has already shown a page crashed the system web view
     * on the test emulator. So a change of pairing makes the window again.
     */
    private void restartWindow() {
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }

    private static JSObject result(String key, boolean value) {
        JSObject out = new JSObject();
        out.put(key, value);
        return out;
    }

    @PluginMethod
    public void session(PluginCall call) {
        JSONObject session = vault.load();
        if (session == null) {
            call.resolve(result("paired", false));
            return;
        }
        call.resolve(result("paired", true).put("origin", session.optString("origin")).put("pairedAt", session.optString("pairedAt"))
            .put("deviceId", session.optString("deviceId")));
    }

    @PluginMethod
    public void forget(PluginCall call) {
        vault.forget();
        call.resolve();
        restartWindow();
    }

    @PluginMethod
    public void request(PluginCall call) {
        JSONObject session = vault.load();
        if (session == null) {
            call.reject("Not paired");
            return;
        }
        getBridge().execute(() -> {
            try {
                BranchClient.Answer answer = BranchClient.sendKept(vault, session, call.getString("method", "GET"), call.getString("path", ""),
                    call.getData().opt("body") == JSONObject.NULL ? null : call.getData().opt("body"),
                    call.getString("base64"), call.getString("contentType"), call.getString("query"));
                JSObject out = new JSObject();
                out.put("status", answer.status);
                out.put("data", answer.json == null ? JSONObject.NULL : answer.json);
                call.resolve(out);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    @PluginMethod
    public void getSwitches(PluginCall call) {
        JSObject out = new JSObject();
        out.put("switches", BranchWords.switches(getContext()));
        call.resolve(out);
    }

    @PluginMethod
    public void setSwitches(PluginCall call) {
        JSObject next = call.getObject("switches", new JSObject());
        BranchWords.saveSwitches(getContext(), next == null ? new JSONObject() : next);
        call.resolve();
    }

    /** Asks for what a switch now needs: permission to notify, the background job, the share target. */
    @PluginMethod
    public void switchesChanged(PluginCall call) {
        BranchShareInbox.applySwitch(getContext());
        BranchNotify.schedule(getContext());
        boolean wantsAlerts = !BranchWords.position(getContext(), "notifications").equals("off");
        if (wantsAlerts && Build.VERSION.SDK_INT >= 33 && getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        call.resolve();
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void afterPermission(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getActivity().runOnUiThread(() -> promptBiometric(call));
            return;
        }
        KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);
        Intent confirm = keyguard == null ? null : keyguard.createConfirmDeviceCredentialIntent(call.getString("reason", "Branch"), null);
        if (confirm == null) {
            call.resolve(result("unlocked", false).put("reason", "unavailable"));
            return;
        }
        startActivityForResult(call, confirm, "afterConfirm");
    }

    @ActivityCallback
    private void afterConfirm(PluginCall call, ActivityResult result) {
        call.resolve(result("unlocked", result.getResultCode() == android.app.Activity.RESULT_OK));
    }

    private void promptBiometric(PluginCall call) {
        BiometricPrompt.Builder builder = new BiometricPrompt.Builder(getContext()).setTitle(call.getString("reason", "Branch"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG
                | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
        } else {
            builder.setDeviceCredentialAllowed(true);
        }
        builder.build().authenticate(new CancellationSignal(), getContext().getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                call.resolve(result("unlocked", true));
            }

            @Override
            public void onAuthenticationError(int code, CharSequence message) {
                call.resolve(result("unlocked", false).put("reason", String.valueOf(message)));
            }
        });
    }

    @PluginMethod
    public void openBranch(PluginCall call) {
        lend.stop(); // PH-03: lending is only while the app's own page shows; Branch's page never sees an ask
        JSONObject session = vault.load();
        if (session == null) {
            call.reject("Not paired");
            return;
        }
        if (!BranchWeb.safeToOpen()) {
            getActivity().runOnUiThread(() -> getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(session.optString("origin")))));
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            BranchWeb.open(getBridge(), session, call.getString("at", ""));
            call.resolve();
        });
    }

    @PluginMethod
    public void look(PluginCall call) {
        JSObject out = new JSObject();
        out.put("theme", BranchWords.state(getContext()).getString("look-theme", "slate"));
        out.put("mode", BranchWords.state(getContext()).getString("look-mode", "dark"));
        call.resolve(out);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        BranchNotify.show(getContext(), call.getString("id", "branch"), call.getString("title", "Branch"), call.getString("body", ""));
        call.resolve();
    }

    @PluginMethod
    public void lendNotify(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (!foreground || !BranchRefusals.sameOrigin(String.valueOf(getBridge().getWebView().getUrl()), getBridge().getAppUrl()))
                    throw new IllegalStateException("Open the phone app’s own page.");
                NotificationManager manager = getContext().getSystemService(NotificationManager.class);
                if (BranchWords.position(getContext(), "notifications").equals("off") || manager == null || !manager.areNotificationsEnabled()
                    || Build.VERSION.SDK_INT >= 33 && getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                    throw new IllegalStateException("Enable notifications on this phone first.");
                String title = call.getString("title", ""), body = call.getString("body", "");
                if (title.isEmpty() || title.length() > 120 || body.length() > 1000) throw new IllegalStateException("Invalid notification text.");
                lend.performAction(call.getString("id", ""), "notify", () -> BranchNotify.show(getContext(), call.getString("id", ""), title, body));
                call.resolve();
            } catch (Exception error) { call.reject(error.getMessage()); }
        });
    }

    @PluginMethod
    public void lendOpen(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (!foreground || !BranchRefusals.sameOrigin(String.valueOf(getBridge().getWebView().getUrl()), getBridge().getAppUrl()))
                    throw new IllegalStateException("Open the phone app’s own page.");
                Uri url = Uri.parse(call.getString("url", ""));
                if (!"https".equals(url.getScheme()) || url.getHost() == null || url.getUserInfo() != null || url.toString().length() > 2048)
                    throw new IllegalStateException("Only HTTPS web addresses without credentials can be opened.");
                lend.performAction(call.getString("id", ""), "open-url", () -> getActivity().startActivity(new Intent(Intent.ACTION_VIEW, url)));
                call.resolve();
            } catch (Exception error) { call.reject(error.getMessage()); }
        });
    }

    @PluginMethod
    public void lastSeen(PluginCall call) {
        JSObject out = new JSObject();
        out.put("at", BranchWords.state(getContext()).getLong("last-seen", 0L));
        call.resolve(out);
    }

    @PluginMethod
    public void takeShared(PluginCall call) {
        JSObject out = new JSObject();
        out.put("items", BranchShareInbox.take());
        call.resolve(out);
    }

    @PluginMethod
    public void clearShared(PluginCall call) {
        BranchShareInbox.take();
        call.resolve();
    }

    // ---- mac7/phone-pairing: this phone as one of the owner's devices (src/devices/) ----

    /** What the page may know: whether this phone is lent, to which computer, and its refusals. */
    @PluginMethod
    public void deviceStatus(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(node.status()));
        } catch (Exception error) {
            call.reject(String.valueOf(error.getMessage()));
        }
    }

    /** mac7/residuals: this phone's public key (never the private half), for the check code the computer shows too. */
    @PluginMethod
    public void deviceKey(PluginCall call) {
        getBridge().execute(() -> {
            try {
                JSObject out = new JSObject();
                out.put("publicKey", node.publicKey());
                call.resolve(out);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    /** Answers the Devices card's invitation, then waits for the owner's yes on the computer. */
    @PluginMethod
    public void devicePair(PluginCall call) {
        String origin = BranchRules.checkOrigin(call.getString("origin", ""));
        if (origin == null) {
            call.resolve(result("paired", false).put("error", BranchWords.word(getContext(), "phone.error.plainHttp", "That address is refused.")));
            return;
        }
        getBridge().execute(() -> {
            try {
                String name = call.getString("name", "");
                String nodeId = node.pair(getContext(), origin, call.getString("offer", ""), call.getString("code", ""),
                    name.isEmpty() ? Build.MODEL : name.substring(0, Math.min(80, name.length())),
                    BranchNode.list(call.getArray("never", new com.getcapacitor.JSArray())));
                call.resolve(result("paired", true).put("nodeId", nodeId));
            } catch (Exception error) {
                call.resolve(result("paired", false).put("error", String.valueOf(error.getMessage())));
            }
        });
    }

    /**
     * B6: connects to a Branch from the window's "Pair a phone" square. The phone answers the invitation as
     * devicePair does and waits for the owner's yes, then collects its session once (POST /api/devices/pair/session,
     * signed with the same key) and keeps it where pair keeps the session from a /pair invitation.
     */
    @PluginMethod
    public void phonePair(PluginCall call) {
        String origin = BranchRules.checkOrigin(call.getString("origin", ""));
        String offer = call.getString("offer", ""), code = call.getString("code", "");
        if (origin == null || !offer.matches("^[a-f0-9]{32}$") || !code.matches("^[0-9]{6}$")) {
            call.resolve(result("paired", false).put("error", BranchWords.word(getContext(), "phone.error.plainHttp", "That address is refused.")));
            return;
        }
        getBridge().execute(() -> {
            try {
                String name = call.getString("name", "");
                JSONObject answer = node.pairPhone(getContext(), origin, offer, code,
                    name.isEmpty() ? Build.MODEL : name.substring(0, Math.min(80, name.length())));
                JSONObject session = new JSONObject().put("origin", origin).put("token", answer.getString("token"))
                    .put("pairedAt", BranchClock.now());
                if (answer.has("deviceId")) session.put("deviceId", answer.getString("deviceId")).put("deviceKey", answer.getString("deviceKey"));
                vault.save(session);
                call.resolve(result("paired", true));
                restartWindow();
            } catch (Exception error) {
                call.resolve(result("paired", false).put("error", String.valueOf(error.getMessage())));
            }
        });
    }

    /** The phone's own refusals. They only take away, so no computer is asked about them. */
    @PluginMethod
    public void deviceNever(PluginCall call) {
        try {
            JSObject out = new JSObject();
            out.put("never", new org.json.JSONArray(node.setNever(BranchNode.list(call.getArray("never", new com.getcapacitor.JSArray())))));
            lend.pause(); // Changing a refusal cancels an outstanding capture before reconnecting with fewer offers.
            lend.resume();
            call.resolve(out);
        } catch (Exception error) {
            call.reject(String.valueOf(error.getMessage()));
        }
    }

    /** Throws this phone's key away; its signature stops working at once. */
    @PluginMethod
    public void deviceForget(PluginCall call) {
        lend.stop();
        node.forget();
        call.resolve();
    }

    // ---- PH-03: lending this phone while the app's own page is open ----

    /** Whether the web view shows the app's own page (never the owner's Branch), asked on the main thread. */
    private boolean appPageShowing() {
        if (!foreground) return false;
        final boolean[] showing = { false };
        final java.util.concurrent.CountDownLatch asked = new java.util.concurrent.CountDownLatch(1);
        getActivity().runOnUiThread(() -> {
            try {
                showing[0] = BranchRefusals.sameOrigin(String.valueOf(getBridge().getWebView().getUrl()), getBridge().getAppUrl());
            } finally {
                asked.countDown();
            }
        });
        try {
            asked.await(2, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        }
        return showing[0];
    }

    /** Dials the Branch this phone is lent to. It takes nothing from the page: the address and the key are this side's. */
    @PluginMethod
    public void lendStart(PluginCall call) {
        lend.start();
        call.resolve();
    }

    @PluginMethod
    public void lendStop(PluginCall call) {
        lend.stop();
        call.resolve();
    }

    /** The page's answer to one ask it was handed (BranchLend.answer checks it). */
    @PluginMethod
    public void lendResult(PluginCall call) {
        getBridge().execute(() -> {
            try {
                lend.answer(call.getData());
                call.resolve();
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    /** The app going to the background closes the socket; coming back dials again if the page still wants lending. */
    @Override
    protected void handleOnPause() {
        foreground = false;
        super.handleOnPause();
        if (lend != null) lend.pause();
    }

    @Override
    protected void handleOnResume() {
        foreground = true;
        super.handleOnResume();
        if (lend != null) lend.resume();
    }

    /** Only the paired Branch opens inside the app; every other address goes to the browser as before. */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        JSONObject session = vault == null ? null : vault.load();
        if (session != null && BranchWeb.safeToOpen() && BranchRules.sameOrigin(url.toString(), session.optString("origin"))) return false;
        return null;
    }

    static ComponentName component(Context context, String name) {
        return new ComponentName(context, context.getPackageName() + name);
    }
}
