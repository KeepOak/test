/**
 * mac7/r17-g (R17-061): the small program that runs a tool script. It is written into the script's
 * scratch folder beside `script.mjs` and started behind the wall. The script calls
 * `branch.call(tool, args)`; each call is one line on descriptor 3, and Branch's answer comes back as
 * one line on standard input. Branch reads only the marked last line as the script's answer.
 */
export const scriptAnswerMarker = "\n@@branch-script-answer@@";

export const scriptHostSource = `import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
const marker = ${JSON.stringify(scriptAnswerMarker)};
const stdoutRpc = process.env.BRANCH_SCRIPT_RPC_STDOUT === "1";
const requests = stdoutRpc ? process.stdout : createWriteStream(null, { fd: 3 });
const waiting = new Map();
let next = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  let answer;
  try { answer = JSON.parse(line); } catch { return; }
  const pending = waiting.get(answer.id);
  if (!pending) return;
  waiting.delete(answer.id);
  if (answer.ok) pending.resolve(answer.result); else pending.reject(new Error(String(answer.error)));
});
const branch = Object.freeze({
  call(tool, args = {}) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      const text = JSON.stringify({ id, tool: String(tool), args });
      if (Buffer.byteLength(text) > 65536) { waiting.delete(id); reject(new Error("RPC request exceeds 65536 bytes")); return; }
      requests.write((stdoutRpc ? "@@branch-script-rpc@@" : "") + text + "\\n");
    });
  },
});
globalThis.branch = branch;
const finish = (value) => {
  let text;
  try { text = JSON.stringify(value); } catch { text = JSON.stringify({ ok: false, error: "the answer could not be written down" }); }
  if (Buffer.byteLength(text) > 60000) text = JSON.stringify({ ok: false, error: "script answer exceeds 60000 bytes" });
  process.stdout.write(marker + text + "\\n", () => stdoutRpc ? process.exit(0) : requests.end(() => process.exit(0)));
};
try {
  const loaded = await import(new URL("./script.mjs", import.meta.url).href);
  const value = typeof loaded.default === "function" ? await loaded.default(branch) : loaded.default;
  finish({ ok: true, result: value === undefined ? null : value });
} catch (error) {
  finish({ ok: false, error: String(error && error.message ? error.message : error).slice(0, 500) });
}
`;
