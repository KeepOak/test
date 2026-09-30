package com.keepoak.branchagent;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Provider;
import java.security.Security;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * mac7/phone-pairing: this phone as one of the owner's devices (src/devices/, docs/configuration.md
 * "Devices"). Everything secret is here and nowhere else:
 *
 *   - the phone's Ed25519 key is made inside the **Android Keystore** where the phone can (Android
 *     13 and later, with a Keystore that knows Ed25519): there it can be used but never read out.
 *     Where it cannot, the key is made in software and sealed at once with an AES key that never
 *     leaves the Keystore; only the sealed bytes sit in the app's own private storage. Either way it
 *     is never handed to the app's page, never logged and never sent: Branch gets the public half;
 *   - pairing and the wait for the owner's yes happen here, because the app's page may only talk to
 *     itself (its Content-Security-Policy). The address rule is {@link BranchRules#checkOrigin},
 *     the same one the page keeps: https anywhere, plain http only to this network or Tailscale.
 *
 * Android learned Ed25519 in Android 13. On an older phone {@link #canSign()} is false and the card
 * says so plainly rather than making a key of some other kind.
 */
final class BranchNode {
    /** What this phone does for Branch when lent, before the owner's refusals (PH-03: BranchLend, phone-node.js APP_OFFERS). */
    static final List<String> OFFERS = BranchLend.OFFERS;
    /** What this phone can promise never to do (apps/mobile/web/rules.js DEVICE_REFUSALS). */
    static final List<String> REFUSALS = Arrays.asList("camera", "screen", "listen", "run", "location", "notify", "open-url", "notification-read", "notification-action");
    private static final String KEY_ALIAS = "branch-node";
    /** The Ed25519 key itself, when this phone's Keystore can hold one. */
    private static final String SIGN_ALIAS = "branch-node-ed25519";
    private static final String PREFS = "branch-node";
    private static final String FIELD = "node";
    private final SharedPreferences prefs;

    BranchNode(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Whether this phone's system can make the kind of key Branch asks for. Found in review: on
     * Android 13+ a plain KeyPairGenerator.getInstance("Ed25519") is the Keystore's own generator,
     * which refuses to make a key without a Keystore spec ("Not initialized"), so the two routes are
     * asked for by name.
     */
    static boolean canSign() {
        return Build.VERSION.SDK_INT >= 33 || softwareEd25519() != null;
    }

    /** A software Ed25519 generator that is not the Keystore's, or null. */
    private static Provider softwareEd25519() {
        Provider[] found = Security.getProviders("KeyPairGenerator.Ed25519");
        if (found == null) return null;
        for (Provider provider : found) if (!"AndroidKeyStore".equals(provider.getName())) return provider;
        return null;
    }

    /** The refusals kept, in a fixed order, with anything unknown dropped. */
    static List<String> keep(List<String> never) {
        List<String> out = new ArrayList<>();
        for (String name : REFUSALS) if (never != null && never.contains(name)) out.add(name);
        return out;
    }

    static List<String> list(JSONArray array) {
        List<String> out = new ArrayList<>();
        for (int at = 0; array != null && at < array.length(); at++) out.add(array.optString(at));
        return out;
    }

    private static SecretKey sealKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    /** Keeps { key (PKCS#8, sealed with the rest), publicKey, hub?, nodeId?, never, pairedAt? }. */
    private void save(JSONObject record) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, sealKey());
        byte[] sealed = cipher.doFinal(record.toString().getBytes(StandardCharsets.UTF_8));
        prefs.edit().putString(FIELD, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "."
            + Base64.encodeToString(sealed, Base64.NO_WRAP)).apply();
    }

    /** What was kept, or null when nothing is lent or it can no longer be opened. */
    JSONObject load() {
        String packed = prefs.getString(FIELD, null);
        if (packed == null || !packed.contains(".")) return null;
        try {
            String[] parts = packed.split("\\.", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, sealKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception error) {
            return null;
        }
    }

    /** What the page may know. The key itself is never part of this. */
    JSONObject status() {
        JSONObject record = load();
        JSONObject out = new JSONObject();
        try {
            out.put("paired", record != null && record.has("hub") && record.has("nodeId"));
            out.put("origin", record == null ? "" : record.optString("hub", ""));
            out.put("nodeId", record == null ? "" : record.optString("nodeId", ""));
            out.put("pairedAt", record == null ? "" : record.optString("pairedAt", ""));
            out.put("never", new JSONArray(keep(list(record == null ? null : record.optJSONArray("never")))));
            out.put("canSign", canSign());
        } catch (Exception ignored) {
            // A JSONObject of plain strings cannot fail; nothing here is worth losing the answer over.
        }
        return out;
    }

    /** The phone's own refusals. They only take away, so no computer is asked about them. */
    List<String> setNever(List<String> never) throws Exception {
        List<String> kept = keep(never);
        JSONObject record = load();
        // Refusals need no key, so any phone keeps them; the key is made when the phone pairs.
        if (record == null) record = new JSONObject();
        record.put("never", new JSONArray(kept));
        save(record);
        return kept;
    }

    /** The refusals kept on this phone, for the web view's camera and microphone gate. */
    List<String> never() {
        JSONObject record = load();
        return keep(list(record == null ? null : record.optJSONArray("never")));
    }

    void forget() {
        prefs.edit().remove(FIELD).apply();
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            store.deleteEntry(SIGN_ALIAS);
        } catch (Exception gone) {
            // nothing was there to throw away
        }
    }

    /** A fresh key for this phone: in the Keystore where it can be, sealed with the rest otherwise. */
    private JSONObject newKey() throws Exception {
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
                generator.initialize(new KeyGenParameterSpec.Builder(SIGN_ALIAS, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("ed25519"))
                    .setDigests(KeyProperties.DIGEST_NONE)
                    .build());
                KeyPair pair = generator.generateKeyPair();
                return new JSONObject().put("keystore", true)
                    .put("publicKey", Base64.encodeToString(pair.getPublic().getEncoded(), Base64.NO_WRAP)).put("never", new JSONArray());
            } catch (Exception unsupported) {
                // This phone's Keystore has no Ed25519: the software key below, sealed by the Keystore.
            }
        }
        Provider software = softwareEd25519();
        if (software == null) throw new IllegalStateException("This phone cannot make the key Branch asks for.");
        KeyPair pair = KeyPairGenerator.getInstance("Ed25519", software).generateKeyPair();
        return new JSONObject()
            .put("key", Base64.encodeToString(pair.getPrivate().getEncoded(), Base64.NO_WRAP))
            .put("publicKey", Base64.encodeToString(pair.getPublic().getEncoded(), Base64.NO_WRAP))
            .put("never", new JSONArray());
    }

    private static PrivateKey privateKey(JSONObject record) throws Exception {
        if (record.optBoolean("keystore", false)) {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            PrivateKey kept = (PrivateKey) store.getKey(SIGN_ALIAS, null);
            if (kept == null) throw new IllegalStateException("This phone's key is gone. Make a new invitation.");
            return kept;
        }
        return KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(Base64.decode(record.getString("key"), Base64.NO_WRAP)));
    }

    private static String sign(JSONObject record, String text) throws Exception {
        Signature signature = Signature.getInstance("Ed25519");
        signature.initSign(privateKey(record));
        signature.update(text.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP);
    }

    /**
     * PH-03: the hello's signature on the device socket, over exactly {@link BranchLend#helloText} for this phone's own
     * id and the challenge's nonce. No other text is signed through here, so nothing can collect a session with it.
     */
    String helloSignature(String nonce) throws Exception {
        JSONObject record = load();
        if (record == null || !record.has("nodeId")) throw new IllegalStateException("This phone is not lent.");
        String text = BranchLend.helloText(record.getString("nodeId"), nonce);
        if (text == null) throw new SecurityException("refused");
        return sign(record, text);
    }

    /** PH-03: the Branch this phone is lent to and its id there, the address checked again by the address rule; or null. */
    String[] lendTarget() {
        JSONObject record = load();
        if (record == null) return null;
        String hub = record.optString("hub", ""), id = record.optString("nodeId", "");
        String checked = BranchRules.checkOrigin(hub);
        if (checked == null || !checked.equals(hub) || !id.matches("^[a-f0-9]{16}$")) return null;
        return new String[] {checked, id};
    }

    /** mac7/residuals: this phone's public key, made and kept now when it has none, so the page can show the check code. */
    String publicKey() throws Exception {
        JSONObject record = load();
        if (record == null) record = new JSONObject().put("never", new JSONArray());
        if (!record.has("publicKey")) {
            JSONObject made = newKey();
            for (String field : new String[] {"key", "keystore", "publicKey"}) if (made.has(field)) record.put(field, made.get(field));
            save(record);
        }
        return record.getString("publicKey");
    }

    /**
     * Sends the invitation's number and this phone's public key, then asks how it went until the
     * owner answers on the computer. Each ask is signed, which is how Branch knows it is this phone.
     */
    String pair(Context context, String origin, String offer, String code, String name, List<String> never) throws Exception {
        return answerInvitation(context, origin, offer, code, name, never)[0];
    }

    /**
     * B6: the window's "Pair a phone" square. Answered and let in as {@link #pair} is, then the phone's session is
     * collected once, signed with this phone's key over "branch-phone-session-v1" and the request id
     * (src/devices/book.ts). Answers { token, deviceId, deviceKey }, the same session a /pair invitation hands over.
     */
    JSONObject pairPhone(Context context, String origin, String offer, String code, String name) throws Exception {
        JSONObject kept = load();
        List<String> never = kept == null ? new ArrayList<>() : list(kept.optJSONArray("never"));
        String requestId = answerInvitation(context, origin, offer, code, name, never)[1];
        JSONObject record = load();
        if (record == null) throw new IllegalStateException(BranchWords.word(context, "phone.device.failed", "That did not work."));
        JSONObject session = post(context, origin + "/api/devices/pair/session", new JSONObject().put("requestId", requestId)
            .put("signature", sign(record, "branch-phone-session-v1\n" + requestId)));
        if (session.optString("token", "").isEmpty())
            throw new IllegalStateException(BranchWords.word(context, "phone.device.failed", "That did not work."));
        return session;
    }

    /** Answers { deviceId, requestId } once the owner lets this phone in. */
    private String[] answerInvitation(Context context, String origin, String offer, String code, String name, List<String> never) throws Exception {
        if (!origin.equals(BranchRules.checkOrigin(origin)) || !offer.matches("^[a-f0-9]{32}$") || !code.matches("^[0-9]{6}$"))
            throw new SecurityException("refused");
        JSONObject record = load();
        if (record == null) record = new JSONObject();
        if (!record.has("publicKey")) {
            JSONObject made = newKey();
            for (String field : new String[] {"key", "keystore", "publicKey"}) if (made.has(field)) record.put(field, made.get(field));
        }
        List<String> kept = keep(never);
        JSONArray offers = new JSONArray();
        for (String capability : OFFERS) if (!kept.contains(capability)) offers.put(capability);
        JSONObject sent = post(context, origin + "/api/devices/pair", new JSONObject().put("offer", offer).put("code", code)
            .put("name", name).put("platform", "android").put("publicKey", record.getString("publicKey")).put("offers", offers));
        String requestId = sent.optString("requestId", "");
        if (requestId.isEmpty()) throw new IllegalStateException(BranchWords.word(context, "phone.device.failed", "That did not work."));
        JSONObject ask = new JSONObject().put("requestId", requestId).put("signature", sign(record, "branch-node-status-v1\n" + requestId));
        for (int tries = 0; tries < 100; tries++) {
            JSONObject answer = post(context, origin + "/api/devices/pair/status", ask);
            String status = answer.optString("status", "");
            if (status.equals("approved") && !answer.optString("deviceId", "").isEmpty()) {
                record.put("hub", origin).put("nodeId", answer.getString("deviceId")).put("never", new JSONArray(kept))
                    .put("pairedAt", BranchClock.now());
                save(record);
                return new String[] {answer.getString("deviceId"), requestId};
            }
            if (status.equals("refused"))
                throw new IllegalStateException(BranchWords.word(context, "phone.node.refused", "The owner refused this phone."));
            Thread.sleep(3000);
        }
        throw new IllegalStateException(BranchWords.word(context, "phone.node.late", "Nobody answered in time."));
    }

    /** One request to the computer's device door. It carries no key: the number and the signature are the proof. */
    private static JSONObject post(Context context, String address, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = connection.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        if (stream != null) {
            try (InputStream in = stream) {
                byte[] buffer = new byte[8192];
                for (int n; (n = in.read(buffer)) > 0; ) bytes.write(buffer, 0, n);
            }
        }
        connection.disconnect();
        Object json = null;
        String text = bytes.toString("UTF-8").trim();
        try { json = text.isEmpty() ? null : new JSONTokener(text).nextValue(); } catch (Exception ignored) { json = null; }
        JSONObject answer = json instanceof JSONObject ? (JSONObject) json : new JSONObject();
        if (status != 200) throw new IllegalStateException(answer.optString("error",
            BranchWords.word(context, "phone.device.failed", "That did not work.")));
        return answer;
    }
}
