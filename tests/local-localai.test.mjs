/**
 * MODEL-086: LocalAI is started only with an existing GGUF and a local llama.cpp backend, in a private folder of its own,
 * with every gallery, download and extra feature switched off, and without the owner's LocalAI settings leaking in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { localAIArgs, localAIChildEnv, localAIModel, prepareLocalAI, removeLocalAIWorkspace } from "../dist/local-localai.js";

test("MODEL-086: LocalAI takes only a real GGUF, runs in its own folder with galleries off, and cleanup keeps the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-localai-"));
  t.after(() => discardTemp(root));
  const gguf = join(root, "tiny.gguf"), text = join(root, "notes.gguf"), backend = join(root, "grpc-server");
  await writeFile(gguf, "GGUF\u0003rest");
  await writeFile(text, "not a model");
  await writeFile(backend, "#!/bin/sh\n");
  await chmod(backend, 0o755);
  const linux = { platform: "linux" };
  await assert.rejects(localAIModel(gguf, backend, { platform: "darwin" }), /only on Linux/);
  await assert.rejects(localAIModel(text, backend, linux), /not a GGUF/);
  await assert.rejects(localAIModel("model.gguf", backend, linux), /absolute/);
  const model = await localAIModel(gguf, backend, linux);
  assert.match(model.model, /^branch-localai-[0-9a-f]{16}$/);
  const workspace = await prepareLocalAI(join(root, "data"), model, 4096);
  assert.equal(await readlink(join(workspace.root, "models", "model.gguf")), model.file);
  assert.equal(JSON.parse(await readFile(join(workspace.root, "models", "model.yaml"), "utf8")).context_size, 4096);
  const args = localAIArgs("local-ai", workspace, "40001");
  assert.ok(args.includes("--disable-gallery-endpoint") && args.includes("--disable-web-ui") && args.includes("--autoload-galleries=false"));
  assert.equal(args[args.indexOf("--address") + 1], "127.0.0.1:40001");
  assert.deepEqual(Object.keys(localAIChildEnv({ PATH: "/bin", LOCALAI_GALLERIES: "x", OPENAI_API_KEY: "k" }, "/h")).sort(),
    ["HF_HUB_OFFLINE", "HOME", "PATH", "TRANSFORMERS_OFFLINE"]);
  await assert.rejects(removeLocalAIWorkspace({ root: root, parent: workspace.parent }), /refused/);
  await removeLocalAIWorkspace(workspace);
  assert.ok((await lstat(gguf)).isFile(), "the owner's model file is kept");
});
