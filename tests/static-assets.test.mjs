import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveEmbedSettings } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** Every script, stylesheet and font the page refers to, including dynamic imports, must actually be served. */
test("every file the page loads is on the server's allowlist and answers 200", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-static-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const publicDir = new URL("../public/", import.meta.url);
  const referenced = new Set();
  /* Redesign: the window is public/index.html, public/app.css and the ES modules under public/app/, which import each
     other by relative path; the pair and people pages keep their own few files. */
  // people.html's files are served only while signing in is switched on (bucket 19), so they aren't required here.
  for (const page of ["index.html", "pair.html"]) {
    const html = await readFile(new URL(page, publicDir), "utf8");
    for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) referenced.add(m[1]);
  }
  const walk = async (dir, at) => {
    for (const entry of await readdir(new URL(dir, publicDir), { withFileTypes: true })) {
      if (entry.isDirectory()) { await walk(`${dir}${entry.name}/`, `${at}${entry.name}/`); continue; }
      if (!entry.name.endsWith(".js")) continue;
      /* A file gone between the listing and the read (tests/window-files.test.mjs, run alongside, adds and removes its own
         probe files in public/app) is not one the window loads; anything else that cannot be read still fails. */
      const source = await readFile(new URL(dir + entry.name, publicDir), "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      });
      for (const m of source.matchAll(/(?:^import\s+[^"'`]*|import\(\s*)["'](\.{1,2}\/[^"']+\.js)["']/gm))
        referenced.add(new URL(m[1], `http://x${at}${entry.name}`).pathname);
    }
  };
  referenced.add("/app/main.js");
  await walk("app/", "/app/");
  const css = await readFile(new URL("app.css", publicDir), "utf8");
  for (const m of css.matchAll(/url\(["']?(\/[^"')]+)["']?\)/g)) referenced.add(m[1]);
  assert.ok(referenced.has("/app/main.js") && referenced.has("/app/core/api.js") && referenced.has("/app.css"), "the scan found the window's modules and stylesheet");
  /* The legacy worker URL is a retirement response; it names no cached shell assets. */
  for (const path of ["/service-worker.js", "/manifest.webmanifest"]) referenced.add(path);
  /* Wave 8: the small box is included by a page of the owner's OWN, so nothing here imports it and
     the scan above cannot see it. It is served only while the owner has switched it on, so switching
     it off takes the box off their page rather than only hiding the setting. */
  assert.equal((await fetch(server.url + "/widget.js")).status, 404,
    "the small box's script is served even though the owner never switched it on");
  saveEmbedSettings(app.store, app.runtime.owner, { widget: true });
  referenced.add("/widget.js");
  const missing = [];
  for (const path of referenced) {
    if (path.startsWith("/api/") || path.startsWith("//")) continue;
    const response = await fetch(server.url + path, { headers: { origin: server.url } });
    if (response.status !== 200) missing.push(`${path} → ${response.status}`);
  }
  assert.deepEqual(missing, [], "these referenced files are not served");
});

/** The owner's dashboard: off at first (nothing under /dashboard is served), then its page and every file it loads,
    following its modules' own imports, answer 200 once it is switched on. */
test("the dashboard's page and every file it loads are served while it is switched on", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-static-dash-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const publicDir = new URL("../public/", import.meta.url);
  assert.equal((await fetch(server.url + "/dashboard")).status, 404, "the dashboard is not served while it is off");
  const on = await fetch(server.url + "/api/dashboard/settings", { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "on" }) });
  assert.equal(on.status, 200, "the owner switches the dashboard on");
  const html = await readFile(new URL("dashboard/index.html", publicDir), "utf8");
  const referenced = new Set(["/dashboard"]);
  for (const m of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) if (m[1] !== "/") referenced.add(m[1]);
  const scripts = [...referenced].filter((path) => path.endsWith(".js"));
  for (let i = 0; i < scripts.length; i++) {
    const source = await readFile(new URL("." + scripts[i], publicDir), "utf8");
    for (const m of source.matchAll(/(?:^import\s+[^"'`]*|import\(\s*)["'](\/[^"']+\.js)["']/gm)) {
      if (!referenced.has(m[1])) { referenced.add(m[1]); scripts.push(m[1]); }
    }
  }
  assert.ok(referenced.has("/dashboard/dashboard.js") && referenced.has("/dashboard/i18n.js"), "the scan followed the dashboard's modules");
  const missing = [];
  for (const path of referenced) {
    const response = await fetch(server.url + path);
    if (response.status !== 200) missing.push(`${path} → ${response.status}`);
  }
  assert.deepEqual(missing, [], "these files the dashboard loads are not served");
});

test("UP-UI-063: the old phone worker address now only retires itself and Branch's own shell caches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-retired-worker-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const response = await fetch(new URL("/service-worker.js", server.url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store", "a browser must fetch the update, not keep the old copy");
  const source = await response.text();
  assert.match(source, /registration\.unregister\(\)/);
  assert.doesNotMatch(source, /addEventListener\("fetch"/, "no page is answered from a cache any more");
  assert.doesNotMatch(source, /caches\.open|cache\.put/);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /serviceWorker\.register/, "the window registers no worker");
});
