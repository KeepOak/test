/**
 * mac7/connect: `branch connect <chat app>` from start to finish, with a fake terminal, fake package
 * managers, a fake opener and a fake Branch behind it. Nothing is installed, opened or contacted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runConnect, connectUsage } from "../dist/channel-setup/command.js";

const token = `123456789:${"Z".repeat(35)}`;

/** A terminal that answers questions in order and remembers everything it printed and ran. */
function fakeIo({ platform = "darwin", answers = [], hidden = [], programs = [], installedAfter = 0, canHide = true, pastePage } = {}) {
  const printed = [], ran = [], asked = [];
  let installChecks = 0;
  const io = {
    platform, canHide, waitMs: 20_000,
    probe: {
      home: "/Users/owner",
      which: async (name) => (programs.includes(name) ? `/bin/${name}` : null),
      exists: async () => installedAfter > 0 && ++installChecks >= installedAfter,
    },
    runner: {
      run: async (command, args, options = {}) => {
        ran.push({ command, args, interactive: options.interactive === true });
        if (command === "winget" && args[0] === "list") return { code: 0, stdout: ++installChecks >= installedAfter && installedAfter ? "Discord.Discord" : "" };
        if (command === "flatpak" && args[0] === "info") return { code: installedAfter && ++installChecks >= installedAfter ? 0 : 1, stdout: "" };
        if (command === "snap" && args[0] === "list") return { code: 1, stdout: "" };
        return { code: 0, stdout: "" };
      },
    },
    write: (line) => printed.push(line),
    ask: async (question) => { asked.push(question); return answers.shift() ?? ""; },
    askHidden: async (question) => { asked.push(question); return hidden.shift() ?? ""; },
    sleep: async () => undefined,
    ...(pastePage ? { pastePage } : {}),
  };
  return { io, printed, ran, asked };
}

function fakeBackend({ mode = "when-needed", fail } = {}) {
  const calls = { saves: [], modes: [], pairings: [] };
  const backend = {
    mode: async () => mode,
    setMode: async (next) => { calls.modes.push(next); mode = next; },
    save: async (id, values, enable) => {
      calls.saves.push({ id, values, enable });
      if (fail) throw new Error(fail);
      return { saved: Object.keys(values).filter((name) => /^[A-Z]/.test(name)), checked: true, botName: "owner_helper_bot", checkNote: null,
        switched: enable ?? null, connectNote: null, entry: id === "telegram" ? null : `{"type":"${id}"}`, pairing: "Send any message to your bot.",
        connected: id === "telegram" ? null : true };
    },
    approvePairing: async (code) => { calls.pairings.push(code); },
  };
  return { backend, calls };
}

test("Telegram on a Mac: asks, installs with Homebrew, opens BotFather in the app, hides the token, switches on and pairs", async () => {
  const { io, printed, ran, asked } = fakeIo({ programs: ["brew"], installedAfter: 3,
    answers: ["y", "", "y", "on", "123456"], hidden: [token] });
  const { backend, calls } = fakeBackend();
  assert.equal(await runConnect("telegram", io, backend), 0);
  const install = ran.find((run) => run.command === "brew");
  assert.deepEqual(install, { command: "brew", args: ["install", "--cask", "telegram"], interactive: true });
  assert.deepEqual(ran.filter((run) => run.command === "open").map((run) => run.args), [["tg://resolve?domain=BotFather&text=%2Fnewbot"]],
    "BotFather opens in the app once it is installed, with /newbot typed");
  assert.deepEqual(calls.saves, [{ id: "telegram", values: { TELEGRAM_BOT_TOKEN: token }, enable: "on" }]);
  assert.deepEqual(calls.pairings, ["123456"]);
  assert.ok(asked.some((question) => /\(hidden\)/.test(question)));
  const said = printed.join("\n");
  assert.ok(!said.includes(token), "the token is never printed");
  assert.match(said, /This installs Telegram, the official app, with Homebrew:\n  brew install --cask telegram/);
  assert.match(said, /accepted it: this is owner_helper_bot/);
  assert.match(said, /Paired/);
});

test("Discord on Windows uses winget and connects without a connections line; nothing is switched by itself", async () => {
  const { io, printed, ran } = fakeIo({ platform: "win32", programs: ["winget"], installedAfter: 2, answers: ["y", "", "y"], hidden: ["discord-token-1234567890"] });
  const { backend, calls } = fakeBackend();
  assert.equal(await runConnect("discord", io, backend), 0);
  assert.deepEqual(ran.find((run) => run.args[0] === "install"),
    { command: "winget", args: ["install", "--exact", "--id", "Discord.Discord", "--source", "winget"], interactive: true });
  assert.deepEqual(ran.filter((run) => run.command === "rundll32").map((run) => run.args),
    [["url.dll,FileProtocolHandler", "https://discord.com/developers/applications?new_application=true"]]);
  assert.equal(calls.saves[0].enable, undefined, "a connections-file app is never switched from here");
  assert.equal(calls.pairings.length, 0);
  // CHAT-147: the running Branch connects it there and then; no connections-file line, no restart.
  assert.match(printed.join("\n"), /Discord is connected now\. Nothing needs restarting\./);
  assert.doesNotMatch(printed.join("\n"), /connections file/);
});

test("Slack on Linux with only Snap says sudo before asking, and opens Slack's filled-in page", async () => {
  const { io, printed, ran } = fakeIo({ platform: "linux", programs: ["snap"], answers: ["y", "", "y"], hidden: ["xoxb-" + "1".repeat(30), "xapp-" + "2".repeat(30)] });
  const { backend, calls } = fakeBackend();
  assert.equal(await runConnect("slack", io, backend), 0);
  assert.deepEqual(ran.find((run) => run.command === "sudo"), { command: "sudo", args: ["snap", "install", "slack"], interactive: true });
  assert.match(printed.join("\n"), /It runs with sudo, so your computer may ask for your password/);
  const opened = ran.find((run) => run.command === "xdg-open");
  assert.match(opened.args[0], /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=%7B/);
  assert.deepEqual(Object.keys(calls.saves[0].values), ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]);
});

test("saying no installs nothing and opens nothing", async () => {
  const { io, printed, ran } = fakeIo({ programs: ["brew"], answers: ["n", "n", "", "n", ""], hidden: [token] });
  const { backend } = fakeBackend();
  assert.equal(await runConnect("telegram", io, backend), 0);
  assert.deepEqual(ran.filter((run) => run.command !== "winget"), [], "no program ran");
  assert.match(printed.join("\n"), /Nothing was installed/);
  assert.match(printed.join("\n"), /https:\/\/t\.me\/BotFather\?text=%2Fnewbot/, "the link is printed instead");
});

test("with no package manager the official download page opens, only after a yes", async () => {
  const { io, printed, ran } = fakeIo({ platform: "darwin", answers: ["y", "", "", "", "n", ""], hidden: [token] });
  const { backend } = fakeBackend();
  assert.equal(await runConnect("telegram", io, backend), 0);
  assert.deepEqual(ran.filter((run) => run.command === "open").map((run) => run.args[0]), ["https://desktop.telegram.org/"]);
  assert.match(printed.join("\n"), /Homebrew is not on this computer/);
  assert.match(printed.join("\n"), /not there yet/, "the wait is bounded");
});

test("while the switch is off it asks first, and a no stops before anything happens", async () => {
  const off = fakeBackend({ mode: "off" });
  const refused = fakeIo({ answers: ["n"] });
  assert.equal(await runConnect("telegram", refused.io, off.backend), 1);
  assert.deepEqual([refused.ran, off.calls.saves, off.calls.modes], [[], [], []]);
  const agreed = fakeIo({ answers: ["y", "n", "n", "", "n", ""], hidden: [token] });
  const later = fakeBackend({ mode: "off" });
  assert.equal(await runConnect("telegram", agreed.io, later.backend), 0);
  assert.deepEqual(later.calls.modes, ["when-needed"]);
});

test("a self-hosted app asks for the server and builds its page from it", async () => {
  const { io, ran } = fakeIo({ platform: "linux", answers: ["https://social.example/", "y", ""], hidden: ["mastodon-token-123"] });
  const { backend, calls } = fakeBackend();
  assert.equal(await runConnect("mastodon", io, backend), 0);
  assert.deepEqual(ran.filter((run) => run.command === "xdg-open").map((run) => run.args[0]), ["https://social.example/settings/applications/new"]);
  assert.equal(calls.saves[0].values.server, "https://social.example/");
  const bad = fakeIo({ platform: "linux", answers: ["http://social.example", "y", ""], hidden: ["x"] });
  await runConnect("mastodon", bad.io, fakeBackend().backend);
  assert.deepEqual(bad.ran.filter((run) => run.command === "xdg-open"), [], "a plain http server is never opened");
  assert.match(bad.printed.join("\n"), /must start with https/);
});

test("an app with nothing to make prints plain steps", async () => {
  const { io, printed, ran } = fakeIo({ platform: "linux", answers: ["irc.libera.chat", "branch-bot", ""], hidden: [""] });
  const { backend, calls } = fakeBackend();
  assert.equal(await runConnect("irc", io, backend), 0);
  assert.equal(ran.length, 0);
  assert.match(printed.join("\n"), /register nicks by chat command[\s\S]*1\. Pick a network/);
  assert.deepEqual(calls.saves[0].values, { server: "irc.libera.chat", nick: "branch-bot" }, "an optional password left empty is not sent");
});

test("a terminal that cannot hide typing uses the one-time page, or stops", async () => {
  const page = { url: "http://127.0.0.1:5555/paste/abc", values: Promise.resolve({ TELEGRAM_BOT_TOKEN: token }) };
  const withPage = fakeIo({ canHide: false, answers: ["n", "n", "", "n", ""], pastePage: async () => page });
  const { backend, calls } = fakeBackend();
  assert.equal(await runConnect("telegram", withPage.io, backend), 0);
  assert.match(withPage.printed.join("\n"), /one-time page on this computer instead:\n  http:\/\/127\.0\.0\.1:5555\/paste\/abc/);
  assert.equal(calls.saves[0].values.TELEGRAM_BOT_TOKEN, token);
  const without = fakeIo({ canHide: false, answers: ["n", "n", "", "n"] });
  const nothing = fakeBackend();
  assert.equal(await runConnect("telegram", without.io, nothing.backend), 1);
  assert.equal(nothing.calls.saves.length, 0);
});

test("a refused token saves nothing and says why; an unknown app lists the real ones", async () => {
  const { io, printed } = fakeIo({ answers: ["n", "n", "", "n", "on"], hidden: [token] });
  const { backend, calls } = fakeBackend({ fail: "Telegram did not accept that (it answered 401)." });
  assert.equal(await runConnect("telegram", io, backend), 1);
  assert.match(printed.join("\n"), /Nothing was saved: Telegram did not accept that/);
  assert.equal(calls.pairings.length, 0);
  const unknown = fakeIo();
  assert.equal(await runConnect("myspace", unknown.io, backend), 2);
  assert.match(unknown.printed[0], /Usage: branch connect <chat app>\nChat apps: telegram, discord, slack/);
  assert.equal(connectUsage().split(", ").length, 56);
});

/* ---------- integration review (adversarial pass) ---------- */

test("integration review: a failed save never prints what was pasted, whatever the error says", async () => {
  const { io, printed } = fakeIo({ answers: ["n", "n", "", "n", "on"], hidden: [token] });
  const { backend } = fakeBackend({ fail: `the service refused ${token} (and ${encodeURIComponent(token)})` });
  assert.equal(await runConnect("telegram", io, backend), 1);
  const said = printed.join("\n");
  assert.match(said, /Nothing was saved: the service refused …/);
  assert.ok(!said.includes(token) && !said.includes(encodeURIComponent(token)), "the token is taken out of the error");
});

test("integration review: the wait for an app is bounded by the clock, even when each look is slow", async () => {
  let clock = 0, looks = 0;
  const { io, printed } = fakeIo({ platform: "win32", programs: ["winget"], answers: ["y", "", "n", ""], hidden: ["discord-token-123456"] });
  io.waitMs = 60_000;
  io.now = () => clock;
  io.sleep = async (ms) => { clock += ms; };
  io.runner.run = async (command, args) => {
    if (command === "winget" && args[0] === "list") { looks += 1; clock += 30_000; } // each look takes its full 30 seconds
    return { code: 0, stdout: "" };
  };
  const { backend, calls } = fakeBackend();
  assert.equal(await runConnect("discord", io, backend), 0);
  assert.match(printed.join("\n"), /It is not there yet/);
  assert.ok(clock <= 60_000 + 3 * 35_000, `waited ${clock / 1000} s against a 60 s limit`);
  assert.ok(looks <= 5, `looked ${looks} times`);
  assert.equal(calls.saves.length, 1, "the command carries on after the wait");
});

test("integration review: a server address that cannot be opened is said, not thrown", async () => {
  const { io, printed, ran } = fakeIo({ platform: "linux", answers: ["https://social.example/it's", "y", ""], hidden: ["mastodon-token-123"] });
  const { backend, calls } = fakeBackend();
  assert.equal(await runConnect("mastodon", io, backend), 0);
  assert.deepEqual(ran.filter((run) => run.command === "xdg-open"), [], "nothing is opened");
  assert.match(printed.join("\n"), /only opens official https and app links/);
  assert.equal(calls.saves.length, 1);
});
