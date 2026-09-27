/**
 * The nightly run's way to a model on another machine whose Ollama listens only on that machine's localhost (a GPU
 * box on the home network): an SSH local port forward (evals/lib/ssh-forward.py), open only while that model's suite
 * runs. The SSH password comes from the Bitwarden vault inside the forward's own process and never passes through here.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const forward = fileURLToPath(new URL("./ssh-forward.py", import.meta.url));

/**
 * Opens the forward and resolves once it listens: { url, close() }. Rejects with the forward's own words (never a
 * secret) when it cannot connect, the local port is taken, or it is not ready within `timeoutMs`.
 */
export function openTunnel({ sshHost, sshUser, bitwardenItem, localPort, remoteHost = "127.0.0.1", remotePort = 11434 }, { timeoutMs = 120_000 } = {}) {
  const python = process.env.EVAL_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const child = spawn(python, [forward, sshHost, sshUser, bitwardenItem, String(localPort), remoteHost, String(remotePort)],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let said = "";
  const close = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const kill = setTimeout(() => child.kill(), 5000);
    child.once("exit", () => { clearTimeout(kill); resolve(); });
    child.stdin.end(); // the forward runs until its standard input closes
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the SSH forward was not ready within ${timeoutMs / 1000}s`)); }, timeoutMs);
    const hear = (chunk) => {
      said += chunk.toString();
      if (/^ready \d+/m.test(said)) { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${localPort}`, close }); }
    };
    child.stdout.on("data", hear);
    child.stderr.on("data", (chunk) => { said += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`the SSH forward did not start: ${error.message}`)); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const words = said.split(/\r?\n/).find((line) => line.startsWith("ssh-forward:")) ?? `it exited ${code}`;
      reject(new Error(words.replace(/^ssh-forward:\s*/, "")));
    });
  });
}
