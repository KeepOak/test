package com.keepoak.branchagent;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * Where the paired Branch's key lives on Android: sealed with an AES key that never leaves the
 * Android Keystore, and kept as ciphertext in the app's private preferences. Nothing here is ever
 * logged, and the phone app's own page never receives the key (BranchWeb says where it does go).
 */
final class BranchVault {
    private static final String KEY_ALIAS = "branch-session";
    private static final String PREFS = "branch-vault";
    private static final String FIELD = "session";
    private final SharedPreferences prefs;
    private final Context context;

    BranchVault(Context context) {
        this.context = context.getApplicationContext();
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
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

    /** Keeps { origin, token, deviceId?, deviceKey?, pairedAt }. */
    void save(JSONObject session) throws Exception {
        JSONObject old = load();
        if (old == null || !BranchTrunkWidget.identity(old).equals(BranchTrunkWidget.identity(session))) {
            BranchTrunkWidget.prefs(context).edit().clear().apply(); BranchTrunkWidget.clear(context);
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] sealed = cipher.doFinal(session.toString().getBytes(StandardCharsets.UTF_8));
        String packed = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(sealed, Base64.NO_WRAP);
        prefs.edit().putString(FIELD, packed).apply();
    }

    /** The kept session, or null when nothing is paired or it can no longer be opened. */
    JSONObject load() {
        String packed = prefs.getString(FIELD, null);
        if (packed == null || !packed.contains(".")) return null;
        try {
            String[] parts = packed.split("\\.", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            byte[] open = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
            JSONObject session = new JSONObject(new String(open, StandardCharsets.UTF_8));
            return BranchRules.checkOrigin(session.optString("origin")) == null ? null : session;
        } catch (Exception error) {
            return null;
        }
    }

    void forget() {
        BranchWords.state(context).edit().remove("widget-chat").remove("widget-id").apply();
        BranchTrunkWidget.prefs(context).edit().clear().apply(); BranchTrunkWidget.clear(context);
        prefs.edit().remove(FIELD).apply();
    }
}
