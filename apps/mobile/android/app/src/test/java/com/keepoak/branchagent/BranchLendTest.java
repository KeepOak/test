package com.keepoak.branchagent;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/** PH-03: the lend socket's rules and framing, without a phone (BranchLend, BranchSocket). */
public class BranchLendTest {
    private static final List<String> NONE = Collections.emptyList();
    private static final String NONCE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456";

    @Test
    public void onlyTheHelloOverThisConnectionsChallengeIsEverSigned() {
        assertEquals("branch-node-hello-v1\n0123456789abcdef\n" + NONCE, BranchLend.helloText("0123456789abcdef", NONCE));
        assertNull("a nonce with a line break could carry another text", BranchLend.helloText("0123456789abcdef", NONCE.substring(1) + "\n"));
        assertNull("a session request is not a hello", BranchLend.helloText("0123456789abcdef", "branch-phone-session-v1"));
        assertNull(BranchLend.helloText("0123456789ABCDEF", NONCE));
        assertNull(BranchLend.helloText("0123456789abcdef", ""));
        assertNull(BranchLend.helloText(null, NONCE));
    }

    @Test
    public void thePhoneOffersOnlyWhatItDoesLessItsOwnRefusals() {
        assertEquals(Arrays.asList("camera", "listen"), BranchLend.offers(NONE));
        assertEquals(Collections.singletonList("listen"), BranchLend.offers(Collections.singletonList("camera")));
        // Branch may switch on what the platform can do; the phone keeps only what it offers.
        assertEquals(Collections.singletonList("camera"), BranchLend.enabledOf(Arrays.asList("camera", "location", "canvas"), NONE));
        assertEquals(NONE, BranchLend.enabledOf(Arrays.asList("camera", "location"), Collections.singletonList("camera")));
    }

    @Test
    public void anAskReachesThePageOnlyWhenEveryRuleAllowsIt() {
        List<String> on = Arrays.asList("camera", "listen");
        long now = 1_000_000L;
        assertNull(BranchLend.refusal("camera", now + 5000, now, NONE, on, true));
        assertEquals("This phone never allows that.", BranchLend.refusal("camera", now + 5000, now, Collections.singletonList("camera"), on, true));
        assertEquals("That is switched off on this phone.", BranchLend.refusal("location", now + 5000, now, NONE, Arrays.asList("camera", "location"), true));
        assertEquals("That is switched off on this phone.", BranchLend.refusal("listen", now + 5000, now, NONE, Collections.singletonList("camera"), true));
        assertEquals("The request came too late.", BranchLend.refusal("camera", now - 1, now, NONE, on, true));
        assertEquals("The request came too late.", BranchLend.refusal("camera", "soon", now, NONE, on, true));
        assertEquals("The Branch app is not open on this phone.", BranchLend.refusal("camera", now + 5000, now, NONE, on, false));
    }

    @Test
    public void theHandshakeIsTheRfcsOwnExampleAndARedirectIsRefused() throws Exception {
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", BranchSocket.acceptFor("dGhlIHNhbXBsZSBub25jZQ=="));
        assertEquals("Zm9vYmE=", BranchSocket.base64("fooba".getBytes(StandardCharsets.US_ASCII)));
        String key = "dGhlIHNhbXBsZSBub25jZQ==";
        String ok = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
        assertTrue(BranchSocket.accepted(ok, key));
        assertFalse(BranchSocket.accepted(ok.replace("s3pP", "x3pP"), key));
        assertFalse(BranchSocket.accepted("HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example/\r\n\r\n", key));
        assertFalse(BranchSocket.accepted("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n", key));
        assertEquals(ok, BranchSocket.head(new ByteArrayInputStream((ok + "rest").getBytes(StandardCharsets.ISO_8859_1))));
        assertTrue(BranchSocket.request("host:3210", "0123456789abcdef", key).startsWith("GET /api/devices/socket?device=0123456789abcdef HTTP/1.1\r\nHost: host:3210\r\n"));
    }

    @Test
    public void framesGoOutMaskedAndComeBackWholeAtEverySize() throws IOException {
        byte[] mask = { 1, 2, 3, 4 };
        for (int size : new int[] { 0, 5, 125, 126, 65535, 65536, 300_000 }) {
            byte[] payload = new byte[size];
            for (int at = 0; at < size; at++) payload[at] = (byte) (at * 7);
            byte[] sent = BranchSocket.frame(0x2, payload, mask);
            assertEquals("every frame from the phone is masked", 0x80, sent[1] & 0x80);
            BranchSocket.Frame back = BranchSocket.read(new ByteArrayInputStream(sent), Integer.MAX_VALUE);
            assertTrue(back.fin);
            assertEquals(0x2, back.opcode);
            assertArrayEquals(payload, back.payload);
        }
        byte[] big = BranchSocket.frame(0x1, new byte[BranchSocket.FRAME_LIMIT + 1], mask);
        try {
            BranchSocket.read(new ByteArrayInputStream(big), BranchSocket.FRAME_LIMIT);
            fail("a frame over the limit is refused");
        } catch (IOException expected) {
            assertEquals("A frame was too large.", expected.getMessage());
        }
    }
}
