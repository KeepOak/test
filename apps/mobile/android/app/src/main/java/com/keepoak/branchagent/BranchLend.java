package com.keepoak.branchagent;

import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import com.keepoak.branchagent.BranchLendGeneration.Pending;

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
    static final List<String> OFFERS = Collections.unmodifiableList(Arrays.asList("camera", "listen", "location", "notify", "open-url"));
    static final int PROTOCOL = 1;
    static final int MEDIA_LIMIT = 8 * 1024 * 1024;

    /** The app's page, as this side needs it. */
    interface Page {
        /** Whether the phone app's own page is the one showing (never the owner's Branch). */
        boolean showing();
        boolean foreground();
        void state(long generation, boolean connected, List<String> enabled);
        void invoke(JSONObject ask);
    }

    private final BranchNode node;
    private final Page page;
    private final BranchLendGeneration lock = new BranchLendGeneration();
    /** The page asked for lending and has not stopped it; a pause keeps it, so coming back dials again. */
    private volatile boolean desired;
    private volatile BranchSocket socket;
    private final Set<String> seen = new HashSet<>();

    void deliver(long generation, Runnable event) { lock.deliver(generation, event); }

    private void clearRequests() {
        lock.enabled = Collections.emptyList();
        lock.waiting.clear();
        seen.clear();
    }

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
        synchronized (lock) { desired = true; }
        connect();
    }

    /** The page no longer wants it (or the phone stops lending): the socket closes and stays closed. */
    void stop() {
        disconnect(true);
    }

    /** The app left the screen: the socket closes, and Branch says this phone is not connected. */
    void pause() {
        disconnect(false);
    }

    /** The app is back on the screen: dials again if the page still wants lending. */
    void resume() {
        connect();
    }

    private void connect() {
        synchronized (lock) {
            if (!desired || lock.thread != null || node.lendTarget() == null) return;
            lock.thread = new Thread(this::run, "branch-lend");
            lock.thread.start();
        }
    }

    /**
     * Ends the current connection at once. The thread that held it is no longer the current one, so
     * whatever it finishes afterwards (an open, a frame, its clean-up) changes nothing a newer one holds.
     */
    private void disconnect(boolean stop) {
        // Close before taking the state monitor: a pending media write must not hold up pause.
        BranchSocket writing = socket;
        if (writing != null) writing.close();
        Thread was;
        BranchSocket open;
        long generation;
        synchronized (lock) {
            if (stop) desired = false;
            was = lock.thread;
            open = socket;
            lock.thread = null;
            socket = null;
            generation = lock.invalidate(this::clearRequests);
        }
        if (open != null) open.close();
        if (was != null) was.interrupt();
        page.state(generation, false, Collections.emptyList());
    }

    private boolean current() {
        synchronized (lock) {
            return lock.thread == Thread.currentThread();
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
            if (lock.thread == Thread.currentThread()) lock.thread = null;
        }
    }

    /** One connection, until it ends. Answers whether the phone proved itself on it. */
    private boolean session(String hub, String deviceId) throws Exception {
        BranchSocket open = BranchSocket.open(hub, deviceId);
        synchronized (lock) {
            if (lock.attach(Thread.currentThread(), open, this::clearRequests) < 0) {
                open.close(); // stopped while it was dialling: this connection belongs to nobody
                return false;
            }
            socket = open;
        }
        boolean proven = false;
        try {
            while (current()) {
                BranchSocket.Frame frame = open.next();
                if (!current()) return proven; // A frame read before pause cannot affect the replacement connection.
                if (!frame.fin || frame.opcode == 0x0 || frame.opcode == 0x8) return proven;
                if (frame.opcode == 0x9) open.send(0xA, frame.payload);
                if (frame.opcode != 0x1) continue;
                JSONObject message = new JSONObject(new String(frame.payload, StandardCharsets.UTF_8));
                proven |= onMessage(open, deviceId, message);
            }
            return proven;
        } finally {
            open.close();
            long generation;
            synchronized (lock) {
                generation = lock.end(Thread.currentThread(), open, () -> {
                    socket = null;
                    clearRequests();
                });
            }
            // Only the connection still current says it ended; one that was replaced or stopped already did.
            if (generation >= 0) page.state(generation, false, Collections.emptyList());
        }
    }

    private boolean onMessage(BranchSocket open, String deviceId, JSONObject message) throws Exception {
        if (!current()) return false;
        String type = message.optString("type", "");
        List<String> never = node.never();
        if (type.equals("challenge")) {
            String nonce = message.optString("nonce", "");
            if (helloText(deviceId, nonce) == null) throw new SecurityException("refused");
            synchronized (lock) {
                if (!lock.current(Thread.currentThread(), open)) return false;
            }
            open.sendText(new JSONObject().put("type", "hello").put("version", PROTOCOL).put("deviceId", deviceId)
                .put("platform", "android").put("offers", new JSONArray(offers(never))).put("signature", node.helloSignature(nonce)).toString());
            return false;
        }
        if (type.equals("welcome") || type.equals("enabled")) {
            List<String> switched = enabledOf(BranchNode.list(message.optJSONArray("enabled")), never);
            return lock.enable(Thread.currentThread(), open, switched, () -> page.state(lock.generation, true, switched));
        }
        if (type.equals("invoke")) onInvoke(open, message);
        else if (type.equals("bye") && message.optString("reason", "").contains("taken off")) {
            // The owner took this phone off the list on the computer: it forgets the pairing, as phone-node.js does.
            lock.apply(Thread.currentThread(), open, () -> {
                desired = false;
                lock.thread = null;
                socket = null;
                long generation = lock.invalidate(this::clearRequests);
                node.forget();
                page.state(generation, false, Collections.emptyList());
            });
        }
        return false;
    }

    private void onInvoke(BranchSocket open, JSONObject ask) throws Exception {
        String id = ask.optString("id", "");
        if (!id.matches("^[a-f0-9]{32}$")) return;
        String capability = ask.optString("capability", "");
        Object deadline = ask.opt("deadline");
        boolean showing = page.showing();
        String why;
        long generation;
        synchronized (lock) {
            if (!lock.current(Thread.currentThread(), open) || !seen.add(id)) return;
            if (seen.size() > 500) seen.clear();
            why = refusal(capability, deadline, System.currentTimeMillis(), node.never(), lock.enabled, showing && page.foreground());
            generation = lock.generation;
            if (why == null) lock.waiting.put(id, new Pending(((Number) deadline).longValue(), generation, capability));
        }
        if (why != null) {
            open.sendText(new JSONObject().put("type", "result").put("id", id).put("ok", false).put("error", why).toString());
            return;
        }
        JSONObject args = ask.optJSONObject("args");
        page.invoke(new JSONObject().put("id", id).put("capability", capability).put("args", args == null ? new JSONObject() : args)
            .put("deadline", ((Number) deadline).longValue()).put("generation", generation));
    }

    /**
     * The page's answer to one ask it was given. Answered once; a picture or sound goes as its own frame
     * after the result, at most 8 MB, as the hub expects (src/devices/protocol.ts mediaFrame).
     */
    void answer(JSONObject from) throws Exception {
        String id = from.optString("id", "");
        Pending pending;
        BranchSocket open;
        synchronized (lock) {
            pending = lock.waiting.get(id);
            open = socket;
            if (pending == null || pending.generation != from.optLong("generation", -1))
                throw new IllegalStateException("That request is not waiting.");
        }
        if (open == null || pending.deadline < System.currentTimeMillis() || !page.showing())
            throw new IllegalStateException("Lending stopped or the request expired.");
        Answer answer = makeAnswer(from, id);
        byte[] framed = frameMedia(id, answer.bytes);
        // Authorization occurs after acquiring the writer, without holding the state gate during I/O.
        // A later disconnect closes this captured transport, never a replacement connection.
        open.sendAnswer(answer.result.toString(), framed,
            () -> lock.authorize(id, pending, open, System.currentTimeMillis(), page::foreground, node::never));
    }

    /** Native effects are bound to an outstanding signed-socket request, never just a page-supplied action. */
    void performAction(String id, String capability, Runnable action) {
        synchronized (lock) {
            BranchLendGeneration.Pending pending = lock.waiting.get(id);
            if (pending == null || pending.generation != lock.generation || socket == null || lock.socket != socket
                || pending.effectCommitted || !pending.capability.equals(capability) || !lock.enabled.contains(capability) || node.never().contains(capability)
                || pending.deadline < System.currentTimeMillis() || !page.foreground())
                throw new IllegalStateException("No current phone action request.");
            pending.effectCommitted = true;
            action.run();
        }
    }
    private static byte[] frameMedia(String id, byte[] bytes) {
        if (bytes == null) return null;
        byte[] framed = new byte[32 + bytes.length];
        System.arraycopy(id.getBytes(StandardCharsets.US_ASCII), 0, framed, 0, 32);
        System.arraycopy(bytes, 0, framed, 32, bytes.length);
        return framed;
    }

    private static final class Answer {
        final JSONObject result;
        byte[] bytes;
        Answer(JSONObject result) { this.result = result; }
    }

    private static Answer makeAnswer(JSONObject from, String id) throws Exception {
        boolean ok = from.optBoolean("ok", false);
        Answer answer = new Answer(new JSONObject().put("type", "result").put("id", id).put("ok", ok));
        if (!ok) {
            String error = from.optString("error", "");
            answer.result.put("error", error.isEmpty() ? "The phone could not do it." : error.substring(0, Math.min(2000, error.length())));
        } else {
            if (from.has("value")) answer.result.put("value", from.get("value"));
            JSONObject media = from.optJSONObject("media");
            if (media != null) {
                String mime = media.optString("mime", ""), name = media.optString("name", "");
                answer.bytes = Base64.decode(media.optString("data", ""), Base64.DEFAULT);
                if (!mime.matches("^(image|audio)/[a-z0-9.+-]{1,60}$") || answer.bytes.length > MEDIA_LIMIT || name.length() > 120)
                    throw new IllegalArgumentException("The picture or sound was larger than Branch accepts.");
                JSONObject meta = new JSONObject().put("mime", mime).put("bytes", answer.bytes.length);
                if (!name.isEmpty()) meta.put("name", name);
                answer.result.put("media", meta);
            }
        }
        return answer;
    }
}
