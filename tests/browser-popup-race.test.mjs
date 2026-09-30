/* A website's pop-up that appears while the assistant is opening a tab of its own is still a pop-up: its
   first request is refused and it is closed. Counting every page that appeared meanwhile as the assistant's
   let such a pop-up through, unguarded (NAS b7f2560). Node only: Playwright's objects are stood in for,
   so the pop-up can be made to arrive at exactly that moment. */
import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSession } from "../dist/integrations/browser-session.js";

function events() {
  const handlers = new Map();
  return {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    emit(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); },
  };
}
function fakePage(name) {
  const page = Object.assign(events(), {
    name, closes: 0,
    close: async () => { page.closes += 1; },
    isClosed: () => page.closes > 0,
    opener: async () => null,
    url: () => "about:blank",
    route: async () => {}, unroute: async () => {}, addInitScript: async () => {}, routeWebSocket: async () => {},
  });
  return page;
}
function fakeRoute(page, url = "http://allowed.test/") {
  const route = {
    outcome: null,
    request: () => ({ url: () => url, resourceType: () => "document", frame: () => ({ page: () => page, parentFrame: () => null }) }),
    abort: async () => { route.outcome = "aborted"; },
    continue: async () => { route.outcome = "continued"; },
  };
  return route;
}

test("a pop-up that opens while the assistant is opening a tab is refused and closed; the assistant's tab is kept", async () => {
  const first = fakePage("first"), ours = fakePage("ours"), popup = fakePage("popup");
  let routeHandler, finishTab;
  const context = Object.assign(events(), {
    setDefaultTimeout() {}, routeWebSocket: async () => {}, addInitScript: async () => {}, close: async () => {},
    route: async (_pattern, handler) => { routeHandler = handler; },
    newCDPSession: async () => ({ on() {}, send: async () => {} }),
    newPage: (() => {
      let made = 0;
      return () => {
        made += 1;
        if (made === 1) { context.emit("page", first); return Promise.resolve(first); }
        return new Promise((resolve) => { finishTab = () => { context.emit("page", ours); resolve(ours); }; });
      };
    })(),
  });
  const session = new BrowserSession(async () => ({ newContext: async () => context }), async () => {});
  const signal = new AbortController().signal;
  await session.use({ owner: "o", runId: "r", signal }, async () => undefined);

  const opening = session.openTab();
  await new Promise((resolve) => setImmediate(resolve));
  // The website's pop-up arrives now, while the assistant's own tab is still being made.
  context.emit("page", popup);
  const popupRequest = fakeRoute(popup, "http://allowed.test/popup");
  const answered = routeHandler(popupRequest);
  finishTab();
  await opening;
  await answered;
  for (let i = 0; i < 20 && popup.closes === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(popupRequest.outcome, "aborted", "the pop-up's first request was refused");
  assert.equal(popup.closes, 1, "and the pop-up was closed");
  assert.equal(ours.closes, 0, "the assistant's own tab was kept");
  const ourRequest = fakeRoute(ours);
  await routeHandler(ourRequest);
  assert.equal(ourRequest.outcome, "continued", "and what it asks for goes through");
  assert.equal(session.tabs().length, 2);
});

test("in the owner's browser, a tab Branch's tab opens sends nothing, even before anyone knows whose it is, and theirs are untouched", async () => {
  const ourTab = fakePage("ours");
  let windowRoute, answerOpener;
  const opened = Object.assign(fakePage("opened"), {
    opener: () => new Promise((resolve) => { answerOpener = () => resolve(ourTab); }),
  });
  const theirs = Object.assign(fakePage("theirs"), { opener: async () => null });
  const context = Object.assign(events(), {
    setDefaultTimeout() {},
    route: async (_pattern, handler) => { windowRoute = handler; },
    unroute: async () => {},
    newCDPSession: async () => ({ on() {}, send: async () => {} }),
    newPage: async () => { await null; context.emit("page", ourTab); return ourTab; }, // Playwright tells of a page after the call returns
  });
  const session = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  session.options = { attached: { context } };
  await session.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);
  const request = (page, url) => {
    const route = { outcome: null, request: () => ({ url: () => url, resourceType: () => "document", frame: () => ({ page: () => page, parentFrame: () => null }) }),
      abort: async () => { route.outcome = "aborted"; }, fallback: async () => { route.outcome = "passed on"; }, continue: async () => { route.outcome = "continued"; } };
    return route;
  };

  // A tab Branch's page opened: its first request arrives before anyone knows whose tab it is.
  context.emit("page", opened);
  const first = request(opened, "http://unlisted.test/");
  const handled = windowRoute(first);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(first.outcome, null, "nothing is sent while the question is open");
  answerOpener();
  await handled;
  for (let i = 0; i < 20 && opened.closes === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(first.outcome, "aborted", "Branch's tab opened it, so it gets nothing");
  assert.equal(opened.closes, 1, "and it is closed");

  // The owner's own tab: passed on as it was, and never closed.
  context.emit("page", theirs);
  const mine = request(theirs, "http://anything.test/");
  await windowRoute(mine);
  assert.equal(mine.outcome, "passed on");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(theirs.closes, 0);
});

test("giving the owner's browser back closes Branch's tabs and the tabs they opened before the window's route comes off", async () => {
  const steps = [];
  const ourTab = Object.assign(fakePage("ours"), { close: async () => { steps.push("closed ours"); } });
  const opened = Object.assign(fakePage("opened"), { opener: async () => ourTab, close: async () => { steps.push("closed opened"); } });
  const theirs = Object.assign(fakePage("theirs"), { close: async () => { steps.push("closed theirs"); } });
  const context = Object.assign(events(), {
    setDefaultTimeout() {},
    route: async () => {},
    unroute: async () => { steps.push("route off"); },
    pages: () => [ourTab, opened, theirs],
    newCDPSession: async () => ({ on() {}, send: async () => {} }),
    newPage: async () => { await null; context.emit("page", ourTab); return ourTab; },
  });
  const session = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  session.options = { attached: { context, detach: async () => { steps.push("detached"); } } };
  await session.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);
  await session.close();
  const off = steps.indexOf("route off");
  assert.ok(off > steps.indexOf("closed ours") && off > steps.indexOf("closed opened") && steps.includes("closed ours") && steps.includes("closed opened"),
    `Branch's tabs and theirs-by-Branch are closed while the route still stands (${steps.join(", ")})`);
  assert.equal(steps.includes("closed theirs"), false, "the owner's own tab is left open");
});

test("in the owner's browser, a new tab's first request is refused when whose tab it is cannot be asked", async () => {
  let windowRoute;
  const ourTab = fakePage("ours");
  const context = Object.assign(events(), {
    setDefaultTimeout() {},
    route: async (_pattern, handler) => { windowRoute = handler; },
    unroute: async () => {},
    pages: () => [ourTab],
    browser: () => ({ newBrowserCDPSession: async () => { throw new Error("Target closed"); } }),
    newCDPSession: async () => ({ on() {}, send: async () => {} }),
    newPage: async () => { await null; context.emit("page", ourTab); return ourTab; },
  });
  const session = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  session.options = { attached: { context } };
  await session.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);
  const route = { outcome: null,
    request: () => ({ url: () => "http://unlisted.test/", resourceType: () => "document", isNavigationRequest: () => true,
      frame: () => { throw new Error("Frame for this navigation request is not available"); } }),
    abort: async () => { route.outcome = "aborted"; }, fallback: async () => { route.outcome = "passed on"; }, continue: async () => { route.outcome = "continued"; } };
  await windowRoute(route);
  assert.equal(route.outcome, "aborted");
});

/** The owner's window with Chrome's target list stood in for: `targets` is what Target.getTargets answers. */
async function borrowedWindow() {
  const ourTab = Object.assign(fakePage("ours"), { tid: "t0" });
  const state = { targets: [{ targetId: "t0", type: "page", url: "http://allowed.test/" }], closed: [], route: null, ourTargetFails: false, unreadable: new Set(), nextPage: null, listFails: false };
  const browserSession = { send: async (method, params) => {
    if (method === "Target.getTargets") {
      if (state.listFails) throw new Error("Target closed");
      return { targetInfos: state.targets.map((target) => ({ ...target })) };
    }
    if (method === "Target.closeTarget") { state.closed.push(params.targetId); state.targets = state.targets.filter((target) => target.targetId !== params.targetId); }
    return {};
  }, detach: async () => {} };
  const context = Object.assign(events(), {
    setDefaultTimeout() {},
    route: async (_pattern, handler) => { state.route = handler; },
    unroute: async () => {},
    pages: () => [ourTab],
    browser: () => ({ newBrowserCDPSession: async () => browserSession }),
    newCDPSession: async (page) => {
      if (page === ourTab && state.ourTargetFails) throw new Error("Target closed");
      return { on() {}, detach: async () => {}, send: async (method) => {
        if (method === "Target.getTargetInfo" && state.unreadable.has(page)) throw new Error("Target closed");
        return { targetInfo: { targetId: page.tid } };
      } };
    },
    newPage: async () => { const page = state.nextPage ?? ourTab; await null; context.emit("page", page); return page; },
  });
  const session = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  session.options = { attached: { context } };
  await session.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);
  const request = (page) => {
    const route = { outcome: null,
      request: () => ({ url: () => "http://unlisted.test/", resourceType: () => "document", isNavigationRequest: () => true,
        frame: () => (page ? { page: () => page, parentFrame: () => null } : (() => { throw new Error("Frame for this navigation request is not available"); })()) }),
      abort: async () => { route.outcome = "aborted"; }, fallback: async () => { route.outcome = "passed on"; }, continue: async () => { route.outcome = "continued"; } };
    return route;
  };
  return { state, context, ourTab, session, send: async (page) => { const route = request(page); await state.route(route); return route.outcome; } };
}

test("in the owner's browser, a tab opened by a tab Branch's tab opened is refused even once that one is closed", async () => {
  const { state, send } = await borrowedWindow();
  state.targets.push({ targetId: "p", type: "page", url: "", openerId: "t0" });
  assert.equal(await send(), "aborted");
  assert.deepEqual(state.closed, ["p"]);
  // p has gone from Chrome's list, but the tab it opened still names it as its opener.
  state.targets.push({ targetId: "g", type: "page", url: "", openerId: "p" });
  assert.equal(await send(), "aborted", "the grandchild sends nothing");
  assert.deepEqual(state.closed, ["p", "g"]);
});

test("in the owner's browser, a tab at the end of a long chain of tabs from Branch's tab is refused", async () => {
  const { state, send } = await borrowedWindow();
  for (let hop = 1; hop <= 12; hop++)
    state.targets.push({ targetId: `c${hop}`, type: "page", url: hop === 12 ? "" : "http://x.test/", openerId: hop === 1 ? "t0" : `c${hop - 1}` });
  assert.equal(await send(), "aborted");
  assert.ok(state.closed.includes("c12"));
});

test("in the owner's browser, a new tab is refused when which tabs are Branch's cannot be read", async () => {
  const { state, send } = await borrowedWindow();
  state.ourTargetFails = true;
  state.targets.push({ targetId: "p", type: "page", url: "", openerId: "t0" });
  assert.equal(await send(), "aborted");
});

test("in the owner's browser, a page whose traced opener has closed is refused and closed; the owner's own is not", async () => {
  const { state, context, send } = await borrowedWindow();
  state.targets.push({ targetId: "p", type: "page", url: "", openerId: "t0" });
  assert.equal(await send(), "aborted"); // p is traced, then closed
  const orphan = Object.assign(fakePage("orphan"), { tid: "g", opener: async () => null });
  const theirs = Object.assign(fakePage("theirs"), { tid: "o1", opener: async () => null });
  state.targets.push({ targetId: "g", type: "page", url: "http://x.test/", openerId: "p" }, { targetId: "o1", type: "page", url: "http://mine.test/" });
  context.emit("page", orphan);
  context.emit("page", theirs);
  assert.equal(await send(orphan), "aborted");
  assert.equal(await send(theirs), "passed on");
  for (let i = 0; i < 20 && orphan.closes === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(orphan.closes, 1);
  assert.equal(theirs.closes, 0);
});

test("in the owner's browser, a page whose traced opener has closed is refused even while a tab of ours cannot be read", async () => {
  const { state, context, session, send } = await borrowedWindow();
  state.targets.push({ targetId: "p", type: "page", url: "", openerId: "t0" });
  assert.equal(await send(), "aborted"); // p is traced, then closed
  // Branch opens a second tab whose id cannot be read, so which tabs are Branch's is not known from here on.
  const second = Object.assign(fakePage("second"), { tid: "t9" });
  state.unreadable.add(second);
  state.nextPage = second;
  await session.openTab();
  const orphan = Object.assign(fakePage("orphan"), { tid: "g", opener: async () => null });
  state.targets.push({ targetId: "g", type: "page", url: "http://x.test/", openerId: "p" });
  context.emit("page", orphan);
  assert.equal(await send(orphan), "aborted");
  for (let i = 0; i < 20 && orphan.closes === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(orphan.closes, 1);
});

test("in the owner's browser, a page whose opener is Branch's own closed tab is refused even while another tab of ours cannot be read", async () => {
  const { state, context, session, send } = await borrowedWindow();
  state.targets.push({ targetId: "c", type: "page", url: "", openerId: "t0" });
  assert.equal(await send(), "aborted"); // Branch's tab id is read here
  const second = Object.assign(fakePage("second"), { tid: "t9" });
  state.unreadable.add(second);
  state.nextPage = second;
  await session.openTab();
  // Branch's first tab has closed, and Chrome names it as the opener of what c opened (NAS 509897e, case A).
  state.targets = state.targets.filter((target) => target.targetId !== "t0");
  const grandchild = Object.assign(fakePage("grandchild"), { tid: "g", opener: async () => null });
  state.targets.push({ targetId: "g", type: "page", url: "http://x.test/", openerId: "t0" });
  context.emit("page", grandchild);
  assert.equal(await send(grandchild), "aborted");
  for (let i = 0; i < 20 && grandchild.closes === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(grandchild.closes, 1);
});

test("in the owner's browser, a page whose opener cannot be asked sends nothing and is not closed, and is asked again", async () => {
  const { state, context, send } = await borrowedWindow();
  state.targets.push({ targetId: "c", type: "page", url: "", openerId: "t0" });
  assert.equal(await send(), "aborted"); // Branch's tab id is known from here
  const theirs = Object.assign(fakePage("theirs"), { tid: "o1", opener: async () => null });
  state.targets.push({ targetId: "o1", type: "page", url: "http://mine.test/" });
  state.listFails = true;
  context.emit("page", theirs);
  assert.equal(await send(theirs), "aborted", "not known either way: nothing is sent");
  state.listFails = false;
  assert.equal(await send(theirs), "passed on", "asked again once Chrome answers, and it is the owner's");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(theirs.closes, 0);
});

test("in the owner's browser, Branch's tab skips service workers, and a tab that cannot is closed and never used", async () => {
  const run = async (refuse) => {
    const tab = fakePage("ours");
    const sent = [];
    const context = Object.assign(events(), {
      setDefaultTimeout() {},
      route: async () => {}, unroute: async () => {},
      newCDPSession: async () => ({ on() {}, send: async (method, params) => {
        sent.push([method, params]);
        if (method === refuse) throw new Error("Target closed");
      } }),
      newPage: async () => { await null; context.emit("page", tab); return tab; },
    });
    const session = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
    session.options = { attached: { context } };
    let used = false;
    const outcome = await session.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => { used = true; })
      .then(() => "used", (error) => error.message);
    return { tab, sent, used, outcome };
  };
  const guarded = await run(null);
  assert.equal(guarded.outcome, "used");
  assert.deepEqual(guarded.sent.find(([method]) => method === "Network.setBypassServiceWorker"), ["Network.setBypassServiceWorker", { bypass: true }]);
  assert.equal(guarded.tab.closes, 0);
  for (const refused of ["Network.enable", "Network.setBypassServiceWorker", "Target.setAutoAttach"]) {
    const failed = await run(refused);
    assert.equal(failed.used, false, `${refused} refused: the tab is never handed to the task`);
    assert.match(failed.outcome, /Target closed/);
    assert.equal(failed.tab.closes, 1, `${refused} refused: the tab is closed`);
  }
});

test("in the owner's browser, a frame of Branch's tab runs only once it skips service workers too; one that cannot never runs", async () => {
  const tab = fakePage("ours");
  const session = Object.assign(events(), { sent: [], send: async (method, params) => { session.sent.push([method, params]); } });
  const context = Object.assign(events(), {
    setDefaultTimeout() {}, route: async () => {}, unroute: async () => {},
    newCDPSession: async () => session,
    newPage: async () => { await null; context.emit("page", tab); return tab; },
  });
  const browser = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  browser.options = { attached: { context } };
  await browser.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);
  assert.deepEqual(session.sent.find(([method]) => method === "Target.setAutoAttach"),
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false }], "every frame is stopped before it runs");
  // What was asked of one frame, in order; each is answered, the bypass with `refuse` if given.
  const askedOf = (child) => session.sent.filter(([method, params]) => method === "Target.sendMessageToTarget" && params.sessionId === child)
    .map(([, params]) => JSON.parse(params.message));
  const answer = async (child, refuse) => {
    for (let round = 0; round < 6; round++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const asked of askedOf(child).slice(round, round + 1))
        session.emit("Target.receivedMessageFromTarget", { sessionId: child, message: JSON.stringify(
          asked.method === refuse ? { id: asked.id, error: { message: "no" } } : { id: asked.id, result: {} }) });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return askedOf(child).map((asked) => asked.method);
  };
  session.emit("Target.attachedToTarget", { sessionId: "ok", targetInfo: { type: "iframe" }, waitingForDebugger: true });
  assert.deepEqual(await answer("ok", null),
    ["Network.enable", "Network.setBypassServiceWorker", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
  session.emit("Target.attachedToTarget", { sessionId: "refused", targetInfo: { type: "iframe" }, waitingForDebugger: true });
  assert.deepEqual(await answer("refused", "Network.setBypassServiceWorker"), ["Network.enable", "Network.setBypassServiceWorker"],
    "a frame that cannot skip them is never let go");
  session.emit("Target.attachedToTarget", { sessionId: "worker", targetInfo: { type: "worker" }, waitingForDebugger: true });
  assert.deepEqual(await answer("worker", null), ["Runtime.runIfWaitingForDebugger"], "a worker is let go at once");
});

test("in the owner's browser, frames inside frames are stopped the same way, and one nested too deep is never let go", async () => {
  const tab = fakePage("ours");
  const session = Object.assign(events(), { sent: [], send: async (method, params) => { session.sent.push([method, params]); } });
  const context = Object.assign(events(), {
    setDefaultTimeout() {}, route: async () => {}, unroute: async () => {},
    newCDPSession: async () => session,
    newPage: async () => { await null; context.emit("page", tab); return tab; },
  });
  const browser = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  browser.options = { attached: { context } };
  await browser.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);
  // Every call to a frame `path` levels down, unwrapped: which frame it is for, and what it asks.
  const unwrap = ([method, params]) => {
    if (method !== "Target.sendMessageToTarget") return null;
    const path = [params.sessionId];
    let message = JSON.parse(params.message);
    while (message.method === "Target.sendMessageToTarget") { path.push(message.params.sessionId); message = JSON.parse(message.params.message); }
    return { path: path.join("/"), message };
  };
  const calls = () => session.sent.map(unwrap).filter(Boolean);
  // A message from a frame, wrapped once for each frame above it, as Chromium sends it.
  const from = (path, message) => {
    let text = JSON.stringify(message);
    for (let at = path.length - 1; at >= 1; at--)
      text = JSON.stringify({ method: "Target.receivedMessageFromTarget", params: { sessionId: path[at], message: text } });
    session.emit("Target.receivedMessageFromTarget", { sessionId: path[0], message: text });
  };
  // Answers each call to this frame as it comes (one at a time, as they are awaited), then says what was asked.
  const settle = async (path) => {
    const mine = () => calls().filter((one) => one.path === path.join("/")).map((one) => one.message);
    let answered = 0;
    for (let round = 0; round < 8; round++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const asked of mine().slice(answered)) { from(path, { id: asked.id, result: {} }); answered += 1; }
    }
    return mine();
  };
  // A frame, a frame inside it, and so on: each gets the same stop for its own frames before it is let go.
  const chain = [];
  for (let depth = 1; depth <= 5; depth++) {
    chain.push(`f${depth}`);
    if (depth === 1) session.emit("Target.attachedToTarget", { sessionId: "f1", targetInfo: { type: "iframe" }, waitingForDebugger: true });
    else from(chain.slice(0, -1), { method: "Target.attachedToTarget", params: { sessionId: `f${depth}`, targetInfo: { type: "iframe" }, waitingForDebugger: true } });
    const asked = await settle(chain);
    if (depth <= 4) {
      assert.deepEqual(asked.map((one) => one.method),
        ["Network.enable", "Network.setBypassServiceWorker", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"], `depth ${depth}`);
      assert.deepEqual(asked[2].params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: false }, `depth ${depth}: its own frames are stopped too`);
    } else {
      assert.deepEqual(asked, [], "a frame nested five sites deep is never let go");
    }
  }
  // What a frame says about the network is never read: it is not even parsed, however often it comes.
  const before = calls().length, parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (...args) => { parsed += 1; return parse(...args); };
  try { from(["f1"], { method: "Network.requestWillBeSent", params: { requestId: "1" } }); } finally { JSON.parse = parse; }
  assert.equal(parsed, 0, "a network event is not parsed");
  // Three frames down, only the two wrappers around it are read, never the event itself (NAS b5daf6f).
  parsed = 0;
  JSON.parse = (...args) => { parsed += 1; return parse(...args); };
  try { from(["f1", "f2", "f3"], { method: "Network.requestWillBeSent", params: { requestId: "2" } }); } finally { JSON.parse = parse; }
  assert.equal(parsed, 2, "at level 3, the two wrappers are read and the network event is not");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls().length, before);
});
