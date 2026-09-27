package com.keepoak.branchagent;

import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * PH-03: lending this phone to Branch, while the phone app's own page is open. This side holds the
 * device socket and the phone's key (BranchNode); the app's page does the one thing asked
 * (apps/mobile/web/phone-node.js serveLending) and hands its answer back.
 *
 * What is checked here, whatever the page or Branch says:
 *   - the socket goes only to the Branch in the sealed record, re-checked by the address rule;
 *   - the only text ever signed is the hello over this connection's own challenge ({@link #helloText});
 *   - an ask is passed to the page only when this phone offers it, the owner switched it on, the
 *     phone's own "never" list allows it, it is still in time, and the app's own page is showing;
 *     anything else is answered "no" at once;
 *   - each ask is answered once, and a picture or sound is at most 8 MB.
 */
final class BranchLend {
    /** What this phone does when lent: its page takes photos and records (Android's WebView cannot speak). */
    static final List<String> OFFERS = Collections.unmodifiableList(Arrays.asList("camera", "listen"));
    static final int PROTOCOL = 1;
    static final int MEDIA_LIMIT = 8 * 1024 * 1024;

    /** The app's page, as this side needs it. */
    interface Page {
        /** Whether the phone app's own page is the one showing (never the owner's Branch). */
        boolean showing();
        void state(boolean connected, List<String> enabled);
        void invoke(JSONObject ask);
    }

    private final BranchNode node;
    private final Page page;
    private final Object lock = new Object();
    /** The page asked for lending and has not stopped it; a pause keeps it, so coming back dials again. */
    private volatile boolean desired;
    private volatile BranchSocket socket;
    private Thread thread;
    private volatile List<String> enabled = Collections.emptyList();
    /** Asks passed to the page and not yet answered, by id, with their deadline. */
    private final Map<String, Long> waiting = Collections.synchronizedMap(new LinkedHashMap<>());
    private final Set<String> seen = Collections.synchronizedSet(new HashSet<>());

    BranchLend(BranchNode node, Page page) {
        this.node = node;
        this.page = page;
    }

    /** Exactly what the phone signs to prove itself (src/devices/protocol.ts helloText), or null for anything else. */
    static String helloText(String deviceId, String nonce) {
        if (deviceId == null || !deviceId.matches("^[a-f0-9]{16}$") || nonce == null || !nonce.matches("^[A-Za-z0-9_-]{43}$")) return null;
        return "branch-node-hello-v1\n" + deviceId + "\n" + nonce;
    }

    /** What this phone offers: what it does, less its own refusals. */
    static List<String> offers(List<String> never) {
        List<String> out = new ArrayList<>();
        for (String capability : OFFERS) if (!never.contains(capability)) out.add(capability);
        return out;
    }

    /** What Branch switched on that this phone offers; anything else stays off here. */
    static List<String> enabledOf(List<String> switched, List<String> never) {
        List<String> out = new ArrayList<>();
        for (String capability : offers(never)) if (switched.contains(capability)) out.add(capability);
        return out;
    }

    /** Why an ask is turned away before the page sees it, or null when it may go to the page. */
    static String refusal(String capability, Object deadline, long now, List<String> never, List<String> enabled, boolean showing) {
        if (never.contains(capability)) return "This phone never allows that.";
        if (!OFFERS.contains(capability) || !enabled.contains(capability)) return "That is switched off on this phone.";
        if (!(deadline instanceof Number) || ((Number) deadline).longValue() < now) return "The request came too late.";
        if (!showing) return "The Branch app is not open on this phone.";
        return null;
    }

    /** The page asks for lending while it is open: dials now, and again whenever the app comes back to the screen. */
    void start() {
        desired = true;
        connect();
    }

    /** The page no longer wants it (or the phone stops lending): the socket closes and stays closed. */
    void stop() {
        desired = false;
        disconnect();
    }

    /** The app left the screen: the socket closes, and Branch says this phone is not connected. */
    void pause() {
        disconnect();
    }

    /** The app is back on the screen: dials again if the page still wants lending. */
    void resume() {
        if (desired) connect();
    }

    private void connect() {
        synchronized (lock) {
            if (thread != null || node.lendTarget() == null) return;
            thread = new Thread(this::run, "branch-lend");
            thread.start();
        }
    }

    /**
     * Ends the current connection at once. The thread that held it is no longer the current one, so
     * whatever it finishes afterwards (an open, a frame, its clean-up) changes nothing a newer one holds.
     */
    private void disconnect() {
        Thread was;
        BranchSocket open;
        synchronized (lock) {
            was = thread;
            open = socket;
            thread = null;
            socket = null;
        }
        if (open != null) open.close();
        if (was != null) was.interrupt();
        enabled = Collections.emptyList();
        waiting.clear();
        page.state(false, Collections.emptyList());
    }

    private boolean current() {
        synchronized (lock) {
            return thread == Thread.currentThread();
        }
    }

    private void run() {
        int failures = 0;
        while (current()) {
            String[] target = node.lendTarget();
            if (target == null) break;
            boolean proven = false;
            try {
                proven = session(target[0], target[1]);
            } catch (Exception gone) {
                // The line dropped or was refused: tried again below, a little later each time.
            }
            failures = proven ? 0 : failures + 1;
            // Refused five times running (switched off on the computer, or the phone taken off): wait for the next time the app opens.
            if (!current() || failures >= 5) break;
            try {
                Thread.sleep(Math.min(30_000L, 1000L << Math.max(0, failures - 1)));
            } catch (InterruptedException stopped) {
                break;
            }
        }
        synchronized (lock) {
            if (thread == Thread.currentThread()) thread = null;
        }
    }

    /** One connection, until it ends. Answers whether the phone proved itself on it. */
    private boolean session(String hub, String deviceId) throws Exception {
        BranchSocket open = BranchSocket.open(hub, deviceId);
        synchronized (lock) {
            if (thread != Thread.currentThread()) {
                open.close(); // stopped while it was dialling: this connection belongs to nobody
                return false;
            }
            socket = open;
        }
        boolean proven = false;
        try {
            while (current()) {
                BranchSocket.Frame frame = open.next();
                if (!frame.fin || frame.opcode == 0x0 || frame.opcode == 0x8) return proven;
                if (frame.opcode == 0x9) open.send(0xA, frame.payload);
                if (frame.opcode != 0x1) continue;
                JSONObject message = new JSONObject(new String(frame.payload, StandardCharsets.UTF_8));
                proven |= onMessage(open, deviceId, message);
            }
            return proven;
        } finally {
            open.close();
            boolean mine;
            synchronized (lock) {
                mine = socket == open;
                if (mine) socket = null;
            }
            // Only the connection still current says it ended; one that was replaced or stopped already did.
            if (mine) {
                enabled = Collections.emptyList();
                waiting.clear();
                page.state(false, Collections.emptyList());
            }
        }
    }

    private boolean onMessage(BranchSocket open, String deviceId, JSONObject message) throws Exception {
        String type = message.optString("type", "");
        List<String> never = node.never();
        if (type.equals("challenge")) {
            String nonce = message.optString("nonce", "");
            if (helloText(deviceId, nonce) == null) throw new SecurityException("refused");
            open.sendText(new JSONObject().put("type", "hello").put("version", PROTOCOL).put("deviceId", deviceId)
                .put("platform", "android").put("offers", new JSONArray(offers(never))).put("signature", node.helloSignature(nonce)).toString());
            return false;
        }
        if (type.equals("welcome") || type.equals("enabled")) {
            enabled = enabledOf(BranchNode.list(message.optJSONArray("enabled")), never);
            page.state(true, enabled);
            return true;
        }
        if (type.equals("invoke")) onInvoke(open, message, never);
        else if (type.equals("bye") && message.optString("reason", "").contains("taken off")) {
            // The owner took this phone off the list on the computer: it forgets the pairing, as phone-node.js does.
            desired = false;
            synchronized (lock) {
                if (thread == Thread.currentThread()) thread = null;
            }
            node.forget();
        }
        return false;
    }

    private void onInvoke(BranchSocket open, JSONObject ask, List<String> never) throws Exception {
        String id = ask.optString("id", "");
        if (!id.matches("^[a-f0-9]{32}$") || !seen.add(id)) return;
        if (seen.size() > 500) seen.clear();
        String capability = ask.optString("capability", "");
        Object deadline = ask.opt("deadline");
        String why = refusal(capability, deadline, System.currentTimeMillis(), never, enabled, page.showing());
        if (why != null) {
            open.sendText(new JSONObject().put("type", "result").put("id", id).put("ok", false).put("error", why).toString());
            return;
        }
        waiting.put(id, ((Number) deadline).longValue());
        JSONObject args = ask.optJSONObject("args");
        page.invoke(new JSONObject().put("id", id).put("capability", capability).put("args", args == null ? new JSONObject() : args)
            .put("deadline", ((Number) deadline).longValue()));
    }

    /**
     * The page's answer to one ask it was given. Answered once; a picture or sound goes as its own frame
     * after the result, at most 8 MB, as the hub expects (src/devices/protocol.ts mediaFrame).
     */
    void answer(JSONObject from) throws Exception {
        String id = from.optString("id", "");
        Long deadline = waiting.remove(id);
        BranchSocket open = socket;
        if (deadline == null || open == null) throw new IllegalStateException("That request is not waiting.");
        boolean ok = from.optBoolean("ok", false);
        JSONObject result = new JSONObject().put("type", "result").put("id", id).put("ok", ok);
        byte[] bytes = null;
        if (!ok) {
            String error = from.optString("error", "");
            result.put("error", error.isEmpty() ? "The phone could not do it." : error.substring(0, Math.min(2000, error.length())));
        } else {
            if (from.has("value")) result.put("value", from.get("value"));
            JSONObject media = from.optJSONObject("media");
            if (media != null) {
                String mime = media.optString("mime", ""), name = media.optString("name", "");
                bytes = Base64.decode(media.optString("data", ""), Base64.DEFAULT);
                if (!mime.matches("^(image|audio)/[a-z0-9.+-]{1,60}$") || bytes.length > MEDIA_LIMIT || name.length() > 120)
                    throw new IllegalArgumentException("The picture or sound was larger than Branch accepts.");
                JSONObject meta = new JSONObject().put("mime", mime).put("bytes", bytes.length);
                if (!name.isEmpty()) meta.put("name", name);
                result.put("media", meta);
            }
        }
        open.sendText(result.toString());
        if (bytes == null) return;
        byte[] framed = new byte[32 + bytes.length];
        System.arraycopy(id.getBytes(StandardCharsets.US_ASCII), 0, framed, 0, 32);
        System.arraycopy(bytes, 0, framed, 32, bytes.length);
        open.send(0x2, framed);
    }
}
