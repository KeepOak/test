#!/usr/bin/env node
/**
 * CHAT-003: the real chat servers tests/real-chat.test.mjs talks to, on this computer only.
 *
 *   node scripts/real-chat/servers.mjs up     fetch (checksums pinned), configure and start them, write the state file
 *   node scripts/real-chat/servers.mjs test   run tests/real-chat.test.mjs against them
 *   node scripts/real-chat/servers.mjs down   stop them
 *
 * Every server listens on 127.0.0.1 only, has no federation and no outside account, and uses throwaway passwords
 * that exist only here. Windows runs Ergo (IRC) and GreenMail (email, needs Java 11+); a WSL distro runs Prosody
 * (XMPP, apt) and tuwunel (Matrix), since neither ships for Windows. Downloads, all under 100 MB together:
 * Ergo 7 MB, GreenMail 11 MB, tuwunel 32 MB, Prosody about 2 MB from apt.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.BRANCH_REAL_CHAT_HOME
  ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "BranchRealChat");
const distro = process.env.BRANCH_REAL_CHAT_WSL ?? "BranchCI";
const inWsl = "/opt/branch-real-chat";
const stateFile = process.env.BRANCH_REAL_CHAT_STATE ?? join(home, "state.json");
const ports = { irc: 16667, smtp: 13025, imap: 13143, xmpp: 15222, xmppTls: 15223, matrix: 16167 };
const registrationToken = "branch-real-chat-local";
const downloads = {
  ergo: { file: "ergo-2.19.1-windows-x86_64.zip", sha256: "5397fac56f7110839aac2d8ab436279eb2a00dddfcc07032605b423e85ea40b6",
    url: "https://github.com/ergochat/ergo/releases/download/v2.19.1/ergo-2.19.1-windows-x86_64.zip" },
  greenmail: { file: "greenmail-standalone-2.1.14.jar", sha256: "0381392f3a44e4d8ae78051778440f58820d01acaf5757c3f43649deda8c1d23",
    url: "https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/2.1.14/greenmail-standalone-2.1.14.jar" },
  tuwunel: { file: "tuwunel-1.9.3.zst", sha256: "98c3b0be352cc03b2c6b21d6f2ed60fedc926f4aab61ce37f0b89eed97d5b756",
    url: "https://github.com/matrix-construct/tuwunel/releases/download/v1.9.3/v1.9.3-release-all-x86_64-v1-linux-gnu-tuwunel.zst" },
};

function run(command, args, { input, cwd } = {}) {
  const done = spawnSync(command, args, { input, cwd, encoding: "utf8", windowsHide: true });
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${done.stderr || done.stdout}`);
  return done.stdout;
}
/** A root shell in the WSL distro; `input` becomes the script's stdin. */
const wsl = (script, input) => run("wsl.exe", ["-d", distro, "-u", "root", "-e", "bash", "-c", script], { input });
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function fetchPinned({ file, url, sha256: expected }) {
  const path = join(home, file);
  if (!existsSync(path)) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const actual = sha256(path);
  if (actual !== expected) throw new Error(`${file}: checksum ${actual}, expected ${expected}. Delete it and run up again.`);
  return path;
}
function startDetached(command, args, cwd) {
  const child = spawn(command, args, { cwd, detached: true, windowsHide: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}
const answers = (port) => new Promise((resolve) => {
  const socket = connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true); });
  socket.on("error", () => resolve(false));
});
/** Waits for the server to listen; with a pid, also that the process started here is the one still running. */
async function listening(port, label, pid) {
  for (let tries = 0; tries < 60; tries++) {
    if (await answers(port)) {
      if (pid) process.kill(pid, 0); // throws when the process started here has already exited
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not start listening on 127.0.0.1:${port}`);
}

/** IRC: Ergo's own default config, with only a loopback plain-text listener and no TLS one. */
async function ircUp() {
  const zip = await fetchPinned(downloads.ergo);
  const dir = join(home, "ergo-2.19.1-windows-x86_64");
  if (!existsSync(join(dir, "ergo.exe"))) run(join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe"), ["-xf", zip], { cwd: home }); // Windows' bsdtar reads zip
  const base = readFileSync(join(dir, "default.yaml"), "utf8").replace(/\r\n/g, "\n");
  let config = base.replace('"127.0.0.1:6667":', `"127.0.0.1:${ports.irc}":`).replace(/^ {8}"\[::1\]:6667":.*$/m, "");
  const tlsAt = config.indexOf('        ":6697":');
  config = config.slice(0, tlsAt) + config.slice(config.indexOf("\n\n", tlsAt));
  if (config.includes(":6697") || !config.includes(`127.0.0.1:${ports.irc}`)) throw new Error("Ergo's default.yaml changed shape");
  writeFileSync(join(dir, "real-chat.yaml"), config);
  if (!existsSync(join(dir, "ircd.db"))) run(join(dir, "ergo.exe"), ["initdb", "--conf", "real-chat.yaml"], { cwd: dir });
  const pid = startDetached(join(dir, "ergo.exe"), ["run", "--conf", "real-chat.yaml"], dir);
  await listening(ports.irc, "Ergo", pid);
  return { pid, state: { host: "127.0.0.1", port: ports.irc } };
}
/** Email: GreenMail, an SMTP and IMAP server in one jar, with two mailboxes. */
async function emailUp() {
  const jar = await fetchPinned(downloads.greenmail);
  const pid = startDetached("java", [`-Dgreenmail.smtp.hostname=127.0.0.1`, `-Dgreenmail.smtp.port=${ports.smtp}`,
    `-Dgreenmail.imap.hostname=127.0.0.1`, `-Dgreenmail.imap.port=${ports.imap}`,
    "-Dgreenmail.users=branch:branchpw@branch.localhost,sam:sampw@branch.localhost", "-Dgreenmail.users.login=email",
    "-Dgreenmail.verbose=false", "-jar", jar], home);
  await listening(ports.smtp, "GreenMail SMTP", pid);
  await listening(ports.imap, "GreenMail IMAP");
  return { pid, state: { domain: "branch.localhost", smtp: { host: "127.0.0.1", port: ports.smtp }, imap: { host: "127.0.0.1", port: ports.imap } } };
}
/** A throwaway CA and a localhost certificate (made in WSL, where openssl is), so XMPP runs with real TLS checks. */
function tlsUp() {
  wsl(`set -e; mkdir -p ${inWsl}/tls; cd ${inWsl}/tls; [ -f ca.pem ] && [ -f localhost.pem ] && exit 0
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=Branch real-chat local CA" -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout localhost.key -out localhost.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\\nbasicConstraints=CA:FALSE\\nextendedKeyUsage=serverAuth\\n' > ext.cnf
openssl x509 -req -in localhost.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 365 -extfile ext.cnf -out localhost.pem 2>/dev/null
chown prosody:prosody localhost.key localhost.pem 2>/dev/null || true; chmod 600 ca.key localhost.key`);
  mkdirSync(join(home, "tls"), { recursive: true });
  const ca = join(home, "tls", "ca.pem");
  writeFileSync(ca, wsl(`cat ${inWsl}/tls/ca.pem`));
  return ca;
}
/** XMPP: Prosody from apt (its own service stays off), on loopback, TLS required, two accounts. */
async function xmppUp() {
  wsl(`set -e; command -v prosody >/dev/null && exit 0
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq prosody zstd >/dev/null; rm -f /usr/sbin/policy-rc.d
systemctl disable --now prosody >/dev/null 2>&1 || true`);
  const ca = tlsUp();
  const config = `-- Branch real-chat harness: a throwaway Prosody on this computer only.
pidfile = "${inWsl}/data/prosody.pid"
data_path = "${inWsl}/data"
log = { info = "*console" }
daemonize = false
admins = { }
modules_enabled = { "roster"; "saslauth"; "tls"; "disco"; "ping"; "posix"; }
c2s_ports = { ${ports.xmpp} }
c2s_direct_tls_ports = { ${ports.xmppTls} }
s2s_ports = { }
interfaces = { "127.0.0.1" }
c2s_require_encryption = true
authentication = "internal_plain"
ssl = { certificate = "${inWsl}/tls/localhost.pem"; key = "${inWsl}/tls/localhost.key"; }
VirtualHost "localhost"
`;
  wsl(`set -e; mkdir -p ${inWsl}/data; cat > ${inWsl}/prosody.cfg.lua; chown -R prosody:prosody ${inWsl}/data ${inWsl}/tls/localhost.key ${inWsl}/tls/localhost.pem
for u in branch:branchpw sam:sampw; do prosodyctl --config ${inWsl}/prosody.cfg.lua register \${u%%:*} localhost \${u#*:} >/dev/null; done
setsid -f runuser -u prosody -- prosody --config ${inWsl}/prosody.cfg.lua -F > ${inWsl}/prosody.log 2>&1 < /dev/null`, config);
  await listening(ports.xmpp, "Prosody");
  return { state: { host: "127.0.0.1", port: ports.xmpp, domain: "localhost", ca } };
}
/** Matrix: tuwunel (a Conduit fork, one binary), loopback only, no federation, sign-up only with the local token. */
async function matrixUp() {
  const zst = await fetchPinned(downloads.tuwunel);
  const config = `# Branch real-chat harness: a throwaway Matrix homeserver on this computer only.
[global]
server_name = "localhost"
address = ["127.0.0.1"]
port = ${ports.matrix}
database_path = "${inWsl}/matrix/db"
allow_registration = true
registration_token = "${registrationToken}"
allow_federation = false
trusted_servers = []
log = "warn"
`;
  const placed = spawnSync("wsl.exe", ["-d", distro, "-u", "root", "-e", "test", "-x", `${inWsl}/matrix/tuwunel`], { windowsHide: true }).status === 0;
  if (!placed) wsl(`set -e; mkdir -p ${inWsl}/matrix; cat > ${inWsl}/matrix/tuwunel.zst`, readFileSync(zst));
  wsl(`set -e; cd ${inWsl}/matrix; [ -x tuwunel ] || { zstd -q -d -f tuwunel.zst -o tuwunel; chmod +x tuwunel; }; cat > tuwunel.toml
setsid -f ./tuwunel -c tuwunel.toml > ${inWsl}/matrix.log 2>&1 < /dev/null`, config);
  await listening(ports.matrix, "tuwunel");
  return { state: { base: `http://127.0.0.1:${ports.matrix}`, domain: "localhost", registrationToken } };
}

async function up() {
  mkdirSync(home, { recursive: true });
  down({ quiet: true });
  for (const port of Object.values(ports)) { // what down stopped may take a moment to let go of its port
    let tries = 0;
    while (await answers(port)) {
      if (++tries > 20) throw new Error(`127.0.0.1:${port} is already in use. Stop whatever holds it, then run up again.`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const irc = await ircUp(), email = await emailUp(), xmpp = await xmppUp(), matrix = await matrixUp();
  const state = { pids: [irc.pid, email.pid], servers: { irc: irc.state, email: email.state, xmpp: xmpp.state, matrix: matrix.state } };
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Up. State in ${stateFile}. Run: node scripts/real-chat/servers.mjs test`);
}
function down({ quiet = false } = {}) {
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { pids: [] };
  for (const pid of state.pids ?? []) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  spawnSync("wsl.exe", ["-d", distro, "-u", "root", "-e", "bash", "-c",
    `pkill -f '${inWsl}/[p]rosody.cfg.lua' ; pkill -f '[t]uwunel -c tuwunel.toml' ; true`], { windowsHide: true });
  if (existsSync(stateFile)) writeFileSync(stateFile, `${JSON.stringify({ servers: {} })}\n`);
  if (!quiet) console.log("Down.");
}
function test() {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const file = join(repo, "tests", "real-chat.test.mjs");
  if (!existsSync(file)) throw new Error(`${file} is missing`);
  const done = spawnSync(process.execPath, ["--test", "--test-timeout=120000", file], { cwd: repo, stdio: "inherit",
    env: { ...process.env, BRANCH_REAL_CHAT_STATE: stateFile, NODE_EXTRA_CA_CERTS: state.servers.xmpp?.ca ?? "" } });
  process.exitCode = done.status ?? 1;
}

const command = process.argv[2];
if (command === "up") await up();
else if (command === "down") down();
else if (command === "test") test();
else { console.error("Usage: node scripts/real-chat/servers.mjs up|test|down"); process.exitCode = 2; }
