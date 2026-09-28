import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("leaving artwork releases retired video sources instead of keeping every visited loop", async (t) => {
  const { page } = await newWindow(t);
  await page.route("**/pool-probe-*.webm", (route) => route.abort());
  const retired = await page.evaluate(async () => {
    const { media17, fill17 } = await import("/app/core/art17.js");
    const box = document.createElement("div");
    document.body.append(box);
    const videos = [];
    for (let i = 0; i < 12; i++) {
      box.innerHTML = media17("/art/branch-idle.webp", `/pool-probe-${i}.webm`, "gate17");
      fill17(box);
      videos.push(box.querySelector("video"));
    }
    box.remove();
    fill17();
    return videos.map((video) => ({ connected: video.isConnected, source: video.getAttribute("src"), paused: video.paused }));
  });
  assert.ok(retired.every((video) => !video.connected && !video.source && video.paused), "all retired decoders lose their resource reference");
});

test("an artwork redraw reuses its playing node before retiring unused media", async (t) => {
  const { page } = await newWindow(t);
  await page.route("**/pool-probe-*.webm", (route) => route.abort());
  const kept = await page.evaluate(async () => {
    const { media17, fill17 } = await import("/app/core/art17.js");
    const box = document.createElement("div");
    document.body.append(box);
    const html = media17("/art/branch-idle.webp", "/pool-probe-same.webm", "gate17");
    box.innerHTML = html;
    fill17(box);
    const first = box.querySelector("video");
    box.innerHTML = html;
    fill17(box);
    return { same: first === box.querySelector("video"), source: first.getAttribute("src") };
  });
  assert.equal(kept.same, true, "a synchronous region redraw preserves the current animation");
  assert.equal(kept.source, "/pool-probe-same.webm");
});

test("a conversation with no Trunk wears a neutral face while a Trunk keeps its own animated character", async (t) => {
  const { page } = await newWindow(t);
  const result = await page.evaluate(async () => {
    const [{ av }, { E }, { looks17 }] = await Promise.all([import("/app/core/ui.js"), import("/app/core/state.js"), import("/app/core/art17.js")]);
    const character = E.characters.find((look) => look.id !== "branch");
    if (!character) throw new Error("No Trunk character catalogue was loaded");
    // A stale catalogue and a saved legacy choice must not restore the mascot.
    E.characters.push({ id: "branch", still: "/art/branch-wave.webp", states: { idle: "/art/anim-idle.webm" }, sizes: [] });
    return { main: av({ kind: "main", name: "Branch" }),
      legacy: av({ id: "legacy", name: "Ledger", character: "branch" }),
      offered: looks17().some((look) => look.id === "branch"),
      trunk: av({ id: "12345678-1234-1234-1234-123456789abc", name: "Scout", character: character.id }) };
  });
  // A conversation with no Trunk wears the neutral tile: the mascot is the logo only (tests/loose-conversation-face).
  assert.match(result.main, /av none18c/);
  assert.doesNotMatch(result.main, /mark-face|av brand/);
  assert.doesNotMatch(result.main, /data-m17|data-rk="branch"/);
  assert.doesNotMatch(result.legacy, /data-m17|branch-wave|anim-idle/);
  assert.equal(result.offered, false);
  assert.match(result.trunk, /data-m17/);
});
