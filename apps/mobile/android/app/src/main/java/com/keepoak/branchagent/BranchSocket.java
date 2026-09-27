package com.keepoak.branchagent;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * PH-03: the phone's end of Branch's device socket (src/devices/hub.ts), a plain RFC 6455 client with
 * nothing the hub does not use: whole text and binary frames, ping and pong, close. No new library:
 * the framing below is what the hub's own reader (src/ws.ts readFrame) expects, and every frame the
 * phone sends is masked, as a client's must be.
 *
 * The address is only ever the Branch this phone was paired with (BranchLend reads it from the sealed
 * record and checks it again). Over https the certificate and the host name are both checked: Java's
 * plain SSLSocket checks neither name nor chain on its own, so the name is asked for by the endpoint
 * rule and then checked once more with the system's own verifier. A reply that is not "101" (a
 * redirect included) ends the attempt.
 */
final class BranchSocket {
    static final String MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    /** The hub's own limit for a text frame; nothing Branch sends a phone comes near it. */
    static final int FRAME_LIMIT = 256 * 1024;
    private static final int HEAD_LIMIT = 8 * 1024;

    /** One frame as it arrived. */
    static final class Frame {
        final boolean fin;
        final int opcode;
        final byte[] payload;

        Frame(boolean fin, int opcode, byte[] payload) {
            this.fin = fin;
            this.opcode = opcode;
            this.payload = payload;
        }
    }

    private final Socket transport;
    private final InputStream in;
    private final OutputStream out;
    private final SecureRandom random = new SecureRandom();

    private BranchSocket(Socket socket) throws IOException {
        this(socket, socket);
    }

    private BranchSocket(Socket socket, Socket transport) throws IOException {
        this.transport = transport;
        this.in = socket.getInputStream();
        this.out = socket.getOutputStream();
    }

    /** Standard base64, for the handshake only (android.util.Base64 is not there in unit tests, java.util's needs Android 8). */
    static String base64(byte[] bytes) {
        final String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        StringBuilder out = new StringBuilder();
        for (int at = 0; at < bytes.length; at += 3) {
            int n = (bytes[at] & 0xff) << 16 | (at + 1 < bytes.length ? (bytes[at + 1] & 0xff) << 8 : 0) | (at + 2 < bytes.length ? bytes[at + 2] & 0xff : 0);
            out.append(alphabet.charAt(n >>> 18 & 63)).append(alphabet.charAt(n >>> 12 & 63));
            out.append(at + 1 < bytes.length ? alphabet.charAt(n >>> 6 & 63) : '=').append(at + 2 < bytes.length ? alphabet.charAt(n & 63) : '=');
        }
        return out.toString();
    }

    /** What the hub must answer for this key (RFC 6455, section 4.2.2). */
    static String acceptFor(String key) throws Exception {
        return base64(MessageDigest.getInstance("SHA-1").digest((key + MAGIC).getBytes(StandardCharsets.US_ASCII)));
    }

    /** The opening request, for this phone's id on the device socket's path. */
    static String request(String hostHeader, String deviceId, String key) {
        return "GET /api/devices/socket?device=" + deviceId + " HTTP/1.1\r\nHost: " + hostHeader
            + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
    }

    /** True only for a "101 Switching Protocols" that upgrades to a websocket with the right accept value. */
    static boolean accepted(String head, String key) throws Exception {
        String[] lines = head.split("\r\n");
        if (lines.length == 0 || !lines[0].matches("^HTTP/1\\.1 101( .*)?$")) return false;
        String upgrade = null, accept = null;
        for (int at = 1; at < lines.length; at++) {
            int colon = lines[at].indexOf(':');
            if (colon <= 0) continue;
            String name = lines[at].substring(0, colon).trim().toLowerCase(Locale.ROOT), value = lines[at].substring(colon + 1).trim();
            if (name.equals("upgrade")) upgrade = value.toLowerCase(Locale.ROOT);
            if (name.equals("sec-websocket-accept")) accept = value;
        }
        return "websocket".equals(upgrade) && acceptFor(key).equals(accept);
    }

    /** One masked frame from the phone. */
    static byte[] frame(int opcode, byte[] payload, byte[] mask) {
        int n = payload.length, head = n < 126 ? 2 : n < 65536 ? 4 : 10;
        byte[] out = new byte[head + 4 + n];
        out[0] = (byte) (0x80 | opcode);
        if (n < 126) {
            out[1] = (byte) (0x80 | n);
        } else if (n < 65536) {
            out[1] = (byte) (0x80 | 126);
            out[2] = (byte) (n >>> 8);
            out[3] = (byte) n;
        } else {
            out[1] = (byte) (0x80 | 127);
            for (int at = 0; at < 8; at++) out[2 + at] = (byte) ((long) n >>> (56 - 8 * at));
        }
        System.arraycopy(mask, 0, out, head, 4);
        for (int at = 0; at < n; at++) out[head + 4 + at] = (byte) (payload[at] ^ mask[at & 3]);
        return out;
    }

    private static int next(InputStream in) throws IOException {
        int value = in.read();
        if (value < 0) throw new EOFException("The socket closed.");
        return value;
    }

    private static byte[] exactly(InputStream in, int length) throws IOException {
        byte[] out = new byte[length];
        for (int got = 0; got < length; ) {
            int n = in.read(out, got, length - got);
            if (n < 0) throw new EOFException("The socket closed.");
            got += n;
        }
        return out;
    }

    /** Reads one frame, refusing anything longer than `limit` before a byte of it is kept. */
    static Frame read(InputStream in, int limit) throws IOException {
        int first = next(in), second = next(in);
        long length = second & 0x7f;
        if (length == 126) length = (next(in) << 8) | next(in);
        else if (length == 127) {
            length = 0;
            for (int at = 0; at < 8; at++) length = (length << 8) | next(in);
        }
        if (length < 0 || length > limit) throw new IOException("A frame was too large.");
        byte[] mask = (second & 0x80) != 0 ? exactly(in, 4) : null;
        byte[] payload = exactly(in, (int) length);
        if (mask != null) for (int at = 0; at < payload.length; at++) payload[at] ^= mask[at & 3];
        return new Frame((first & 0x80) != 0, first & 0x0f, payload);
    }

    /** The reply's head, up to the blank line, refused past 8 KB. */
    static String head(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int value = next(in);
            bytes.write(value);
            if (bytes.size() > HEAD_LIMIT) throw new IOException("The reply was too long.");
            matched = value == (matched % 2 == 0 ? '\r' : '\n') ? matched + 1 : value == '\r' ? 1 : 0;
        }
        return bytes.toString("ISO-8859-1");
    }

    /**
     * Dials the paired Branch's device socket for this phone's id. `hub` must already be the checked
     * origin from the sealed record (BranchLend); nothing the page says reaches here.
     */
    static BranchSocket open(String hub, String deviceId) throws Exception {
        URL url = new URL(hub);
        boolean tls = "https".equals(url.getProtocol());
        String host = url.getHost();
        String bare = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        int port = url.getPort() == -1 ? (tls ? 443 : 80) : url.getPort();
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(bare, port), 15000);
        raw.setSoTimeout(15_000); // Includes TLS negotiation, before a lend connection exists to close.
        Socket socket = raw;
        try {
            if (tls) {
                SSLSocket secure = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, bare, port, true);
                SSLParameters parameters = secure.getSSLParameters();
                parameters.setEndpointIdentificationAlgorithm("HTTPS");
                secure.setSSLParameters(parameters);
                secure.startHandshake();
                if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(bare, secure.getSession()))
                    throw new SSLPeerUnverifiedException("The certificate is not for " + bare + ".");
                socket = secure;
            }
            // The hub pings every 25 seconds; three minutes of nothing at all means the line is gone.
            socket.setSoTimeout(180_000);
            BranchSocket client = new BranchSocket(socket, raw);
            byte[] nonce = new byte[16];
            client.random.nextBytes(nonce);
            String key = base64(nonce);
            String hostHeader = url.getPort() == -1 ? host : host + ":" + port;
            client.out.write(request(hostHeader, deviceId, key).getBytes(StandardCharsets.US_ASCII));
            client.out.flush();
            if (!accepted(head(client.in), key)) throw new IOException("Branch did not open the device socket.");
            return client;
        } catch (Exception error) {
            raw.close();
            throw error;
        }
    }

    Frame next() throws IOException {
        return read(in, FRAME_LIMIT);
    }

    synchronized void send(int opcode, byte[] payload) throws IOException {
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        out.write(frame(opcode, payload, mask));
        out.flush();
    }

    void sendText(String text) throws IOException {
        send(0x1, text.getBytes(StandardCharsets.UTF_8));
    }

    void close() {
        // Closing the transport interrupts a blocked send/read. Never acquire the send monitor here:
        // lifecycle pause runs on the main thread, even when the peer stopped reading a media frame.
        try {
            transport.close(); // The raw socket also interrupts TLS; no close-notify write can wait for the peer.
        } catch (IOException ignored) {
            // closed either way
        }
    }
}
