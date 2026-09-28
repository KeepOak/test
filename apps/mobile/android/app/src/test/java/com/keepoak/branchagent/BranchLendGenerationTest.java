package com.keepoak.branchagent;

import static org.junit.Assert.*;
import java.util.HashMap;
import java.util.Map;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** Real production identity gate, with delayed workers. Runs on the hosted JVM, without Android stubs. */
public class BranchLendGenerationTest {
    private static final class Rig {
        final BranchLendGeneration gate = new BranchLendGeneration();
        final Object old = new Object(), replacement = new Object();
        final Map<String, Long> waiting = new HashMap<>();
        final AtomicInteger forgotten = new AtomicInteger(), delivered = new AtomicInteger();
        final AtomicReference<String> enabled = new AtomicReference<>("camera");

        void replace() {
            synchronized (gate) {
                gate.thread = new Thread();
                gate.invalidate(waiting::clear);
                gate.attach(gate.thread, replacement, waiting::clear);
                waiting.put("new request", 99L);
                enabled.set("listen");
            }
        }
    }

    private static void await(CountDownLatch latch) {
        try { assertTrue("latch timed out", latch.await(2, TimeUnit.SECONDS)); }
        catch (InterruptedException interrupted) { throw new AssertionError(interrupted); }
    }

    private static void delayed(Rig rig, Runnable oldAction) throws Exception {
        CountDownLatch read = new CountDownLatch(1), release = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try { read.countDown(); await(release); oldAction.run(); }
            catch (Throwable problem) { failure.set(problem); }
        });
        rig.gate.thread = worker;
        rig.gate.attach(worker, rig.old, rig.waiting::clear);
        worker.start(); await(read);
        rig.replace(); release.countDown(); worker.join(2000);
        assertFalse("old worker did not stop", worker.isAlive());
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    @Test public void oldWelcomeCannotChangeReplacementSwitches() throws Exception {
        Rig rig = new Rig();
        delayed(rig, () -> assertFalse(rig.gate.apply(Thread.currentThread(), rig.old,
            () -> rig.enabled.set("camera"))));
        assertEquals("listen", rig.enabled.get());
    }

    @Test public void oldTakenOffCannotForgetReplacementPairing() throws Exception {
        Rig rig = new Rig();
        delayed(rig, () -> assertFalse(rig.gate.apply(Thread.currentThread(), rig.old,
            () -> { rig.gate.thread = null; rig.forgotten.incrementAndGet(); })));
        assertEquals(0, rig.forgotten.get());
        assertNotNull(rig.gate.thread);
        assertSame(rig.replacement, rig.gate.socket);
    }

    @Test public void oldFinallyCannotClearReplacementPendingRequests() throws Exception {
        Rig rig = new Rig();
        delayed(rig, () -> assertEquals(-1, rig.gate.end(Thread.currentThread(), rig.old, rig.waiting::clear)));
        assertEquals(Long.valueOf(99), rig.waiting.get("new request"));
        assertSame(rig.replacement, rig.gate.socket);
    }

    @Test public void queuedOldUiCallbackIsDiscardedAfterReconnect() throws Exception {
        Rig rig = new Rig();
        // The delayed action runs after a new generation, just like the Android UI queue.
        delayed(rig, () -> rig.gate.deliver(1, rig.delivered::incrementAndGet));
        assertEquals(0, rig.delivered.get());
        rig.gate.deliver(rig.gate.generation, rig.delivered::incrementAndGet);
        assertEquals(1, rig.delivered.get());
    }

    @Test public void sameWorkerRetryStillInvalidatesQueuedOldCallbacks() {
        Rig rig = new Rig();
        rig.gate.thread = Thread.currentThread();
        long old = rig.gate.attach(Thread.currentThread(), rig.old, rig.waiting::clear);
        rig.gate.end(Thread.currentThread(), rig.old, rig.waiting::clear);
        rig.gate.attach(Thread.currentThread(), rig.replacement, rig.waiting::clear);
        rig.gate.deliver(old, rig.delivered::incrementAndGet);
        assertEquals(0, rig.delivered.get());
    }

    @Test public void queuedAnswerCannotSendAfterItsCapabilityIsDisabled() throws Exception {
        Rig rig = new Rig();
        CountDownLatch queued = new CountDownLatch(1), release = new CountDownLatch(1);
        AtomicInteger sends = new AtomicInteger();
        Thread worker = new Thread(() -> {
            BranchLendGeneration.Pending pending = rig.gate.waiting.get("capture");
            queued.countDown(); await(release);
            // This is the same final authorization the real lender uses before writing a result.
            if (rig.gate.authorize("capture", pending, rig.old, 5, () -> true, Collections::emptyList)) sends.incrementAndGet();
        });
        rig.gate.thread = worker;
        long generation = rig.gate.attach(worker, rig.old, () -> {});
        rig.gate.enable(worker, rig.old, Collections.singletonList("camera"), () -> {});
        BranchLendGeneration.Pending pending = new BranchLendGeneration.Pending(99, generation, "camera");
        rig.gate.waiting.put("capture", pending);
        worker.start(); await(queued);
        // Native execution is queued until after the enabled-off message has revoked its pending capture.
        rig.gate.enable(worker, rig.old, Collections.singletonList("listen"), () -> {});
        rig.gate.waiting.put("other", new BranchLendGeneration.Pending(99, generation, "listen"));
        release.countDown(); worker.join(2000);
        assertFalse(worker.isAlive());
        assertEquals(0, sends.get());
        assertFalse(rig.gate.waiting.containsKey("capture"));
        assertTrue(rig.gate.waiting.containsKey("other"));
    }
}
