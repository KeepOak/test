package com.keepoak.branchagent;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.net.Socket;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** A slow peer must not make Activity.pause wait for the media writer's monitor. Runs on the hosted Android runner. */
public class BranchSocketCloseTest {
    private static final class BlockedSocket extends Socket {
        final CountDownLatch writing = new CountDownLatch(1);
        final CountDownLatch closed = new CountDownLatch(1);

        @Override public InputStream getInputStream() { return new ByteArrayInputStream(new byte[0]); }
        @Override public OutputStream getOutputStream() {
            return new OutputStream() {
                @Override public void write(int value) throws IOException {
                    writing.countDown();
                    try {
                        if (!closed.await(2, TimeUnit.SECONDS)) throw new IOException("close never interrupted writing");
                    } catch (InterruptedException interrupted) { throw new IOException(interrupted); }
                    throw new IOException("transport closed");
                }
            };
        }
        @Override public void close() { closed.countDown(); }
    }

    @Test(timeout = 3000)
    public void closeInterruptsBlockedWriterWithoutWaitingForItsMonitor() throws Exception {
        BlockedSocket transport = new BlockedSocket();
        Socket secure = new Socket() {
            @Override public InputStream getInputStream() { return transport.getInputStream(); }
            @Override public OutputStream getOutputStream() { return transport.getOutputStream(); }
            @Override public void close() { throw new AssertionError("Closing TLS could wait for a close-notify write"); }
        };
        Constructor<BranchSocket> constructor = BranchSocket.class.getDeclaredConstructor(Socket.class, Socket.class);
        constructor.setAccessible(true);
        BranchSocket socket = constructor.newInstance(secure, transport);
        Thread writer = new Thread(() -> {
            try { socket.send(0x2, new byte[8192]); } catch (IOException expected) { /* cancelled */ }
        });
        writer.start();
        try {
            assertTrue(transport.writing.await(1, TimeUnit.SECONDS));
            Thread closer = new Thread(socket::close);
            closer.start();
            assertTrue("close does not wait for a network write", transport.closed.await(250, TimeUnit.MILLISECONDS));
            closer.join(250);
            writer.join(250);
            assertTrue("the writer was released", !writer.isAlive());
            assertTrue("close returned", !closer.isAlive());
        } finally { transport.close(); writer.join(500); }
    }

    @Test(timeout = 3000)
    public void queuedResultChecksRevocationAfterAcquiringWriter() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        Socket transport = new Socket() {
            @Override public InputStream getInputStream() { return new ByteArrayInputStream(new byte[0]); }
            @Override public OutputStream getOutputStream() { return bytes; }
        };
        Constructor<BranchSocket> constructor = BranchSocket.class.getDeclaredConstructor(Socket.class, Socket.class);
        constructor.setAccessible(true);
        BranchSocket socket = constructor.newInstance(transport, transport);
        AtomicBoolean allowed = new AtomicBoolean(true), refused = new AtomicBoolean(false);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread writer = new Thread(() -> {
            try { socket.sendAnswer("result", new byte[] {1}, allowed::get); }
            catch (IllegalStateException revoked) { refused.set(true); }
            catch (Throwable problem) { failure.set(problem); }
        });
        synchronized (socket) {
            writer.start();
            long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (writer.getState() != Thread.State.BLOCKED && System.nanoTime() < end) Thread.sleep(1);
            assertEquals(Thread.State.BLOCKED, writer.getState());
            allowed.set(false);
        }
        writer.join(1000);
        assertTrue(!writer.isAlive());
        if (failure.get() != null) throw new AssertionError(failure.get());
        assertTrue(refused.get());
        assertEquals(0, bytes.size());
    }
}
