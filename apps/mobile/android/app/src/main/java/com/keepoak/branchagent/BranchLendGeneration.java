package com.keepoak.branchagent;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** Connection identity gate. Its monitor also protects the lender's switches and pending requests. */
final class BranchLendGeneration {
    Thread thread;
    Object socket;
    long generation;
    List<String> enabled = Collections.emptyList();
    final Map<String, Pending> waiting = new LinkedHashMap<>();

    static final class Pending {
        final long deadline, generation;
        final String capability;
        boolean effectCommitted;
        Pending(long deadline, long generation, String capability) {
            this.deadline = deadline;
            this.generation = generation;
            this.capability = capability;
        }
    }

    synchronized boolean enable(Thread worker, Object connection, List<String> switched, Runnable event) {
        return apply(worker, connection, () -> {
            enabled = switched;
            waiting.entrySet().removeIf(entry -> !switched.contains(entry.getValue().capability));
            event.run();
        });
    }

    /** Final authorization of a queued result; a revoked or replaced request is never consumed. */
    synchronized boolean authorize(String id, Pending pending, Object connection, long now, BooleanSupplier foreground, Supplier<List<String>> never) {
        if (pending == null || socket != connection || generation != pending.generation || waiting.get(id) != pending
            || !enabled.contains(pending.capability) || never.get().contains(pending.capability)
            || !foreground.getAsBoolean() || pending.deadline < now) return false;
        waiting.remove(id);
        return true;
    }

    synchronized long invalidate(Runnable clear) {
        generation++;
        socket = null;
        clear.run();
        return generation;
    }

    synchronized long attach(Thread worker, Object connection, Runnable clear) {
        if (thread != worker) return -1;
        invalidate(clear);
        socket = connection;
        return generation;
    }

    synchronized boolean current(Thread worker, Object connection) {
        return thread == worker && socket == connection;
    }

    synchronized boolean apply(Thread worker, Object connection, Runnable change) {
        if (!current(worker, connection)) return false;
        change.run();
        return true;
    }

    synchronized long end(Thread worker, Object connection, Runnable clear) {
        if (!current(worker, connection)) return -1;
        return invalidate(clear);
    }

    /** Called on the UI thread: a queued event is delivered only for the generation that made it. */
    synchronized void deliver(long expected, Runnable event) {
        if (generation == expected) event.run();
    }
}
