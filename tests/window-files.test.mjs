/**
 * Redesign: the new window's files (public/app/**, public/art/**) are served by exact name from a list read once
 * from those folders; nothing from the request is joined onto a disk path. A scripted model; no provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const appDir = fileURLToPath(new URL("../public/app/", import.meta.url));
const probe = `window-files-probe-${process.pid}`;

/** A GET with the path sent exactly as written, so ".." and "%2e" reach the server unchanged. */
function get(url, path) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(url), { path, method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function served(t) {
  const made = !existsSync(appDir);
  await mkdir(join(appDir, "nested"), { recursive: true });
  await writeFile(join(appDir, `${probe}.js`), "export const probe = 1;\n");
  await writeFile(join(appDir, "nested", `${probe}.css`), ".probe{}\n");
  await writeFile(join(appDir, `${probe}.txt`), "not a window file\n");
  const root = await mkdtemp(join(tmpdir(), "branch-window-files-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => {
    await server.close(); await app.close(); await discardTemp(root);
    for (const file of [`${probe}.js`, `${probe}.txt`, `${probe}-late.js`, join("nested", `${probe}.css`)])
      await rm(join(appDir, file), { force: true });
    if (made) await rm(appDir, { recursive: true, force: true });
  });
  return server;
}

test("the new window's files are served by exact name, with the engine's security headers", async (t) => {
  const server = await served(t);
  const js = await get(server.url, `/app/${probe}.js`);
  assert.equal(js.status, 200);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.match(js.headers["content-security-policy"], /script-src 'self'; style-src 'self'/);
  assert.equal(js.headers["x-content-type-options"], "nosniff");
  assert.equal(js.body, "export const probe = 1;\n");
  const css = await get(server.url, `/app/nested/${probe}.css`);
  assert.equal(css.status, 200, "files in folders under public/app are served too");
  assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
});

test("nothing outside the list is served: climbing out, other kinds of file, other spellings", async (t) => {
  const server = await served(t);
  for (const path of ["/app/../package.json", "/app/%2e%2e/package.json", "/app/..%2fpackage.json", "/app/nested/../../package.json",
    `/app/${probe}.txt`, `/app/${probe}.JS`, `/app//${probe}.js`, "/art/../../package.json"]) {
    const answer = await get(server.url, path);
    assert.notEqual(answer.status, 200, `${path} is not served`);
    assert.doesNotMatch(answer.body, /"name": "branch-agent"|not a window file/, `${path} gives nothing away`);
  }
});

test("the list is read once: a file added after the first request is not served", async (t) => {
  const server = await served(t);
  assert.equal((await get(server.url, `/app/${probe}.js`)).status, 200);
  await writeFile(join(appDir, `${probe}-late.js`), "export const late = 1;\n");
  assert.notEqual((await get(server.url, `/app/${probe}-late.js`)).status, 200);
});
