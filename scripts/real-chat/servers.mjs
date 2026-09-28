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
const ports = { irc: 16667, smtp: 13025, imap: 13143, xmpp: 15222, xmppTls: 15223, matrix: 16167, mqtt: 11883, gotify: 18080, ntfy: 18090, mumble: 16473, nostr: 17447, simplexBot: 15225, simplexPerson: 15226 };
const registrationToken = "branch-real-chat-local";
const downloads = {
  ergo: { file: "ergo-2.19.1-windows-x86_64.zip", sha256: "5397fac56f7110839aac2d8ab436279eb2a00dddfcc07032605b423e85ea40b6",
    url: "https://github.com/ergochat/ergo/releases/download/v2.19.1/ergo-2.19.1-windows-x86_64.zip" },
  greenmail: { file: "greenmail-standalone-2.1.14.jar", sha256: "0381392f3a44e4d8ae78051778440f58820d01acaf5757c3f43649deda8c1d23",
    url: "https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/2.1.14/greenmail-standalone-2.1.14.jar" },
  tuwunel: { file: "tuwunel-1.9.3.zst", sha256: "98c3b0be352cc03b2c6b21d6f2ed60fedc926f4aab61ce37f0b89eed97d5b756",
    url: "https://github.com/matrix-construct/tuwunel/releases/download/v1.9.3/v1.9.3-release-all-x86_64-v1-linux-gnu-tuwunel.zst" },
  gotify: { file: "gotify-windows-amd64.exe.zip", sha256: "dea4183870bff3fecbc158aebb12a4a9ed69be9da18d1ba6a5d3490ae530bbb1",
    url: "https://github.com/gotify/server/releases/download/v3.1.1/gotify-windows-amd64.exe.zip" },
  deltachat: { file: "deltachat-rpc-server-2.62.0-win64.exe", sha256: "b2813cd7f40379c8c5a255dc4d67f8c81a9d7ee4652031ebf04563b3bcb09cee",
    url: "https://github.com/chatmail/core/releases/download/v2.62.0/deltachat-rpc-server-win64.exe" },
  nak: { file: "nak-v0.20.7-windows-amd64.exe", sha256: "e759002c783442f3b5b082e31e56d2db0b1e2b42f61d87b68d72d93035eb39c4",
    url: "https://github.com/fiatjaf/nak/releases/download/v0.20.7/nak-v0.20.7-windows-amd64.exe" },
  smp: { file: "smp-server-6.5.0-ubuntu-24_04", sha256: "0ec0984a9f15d8a140c96e0c84948e37f581ed0a0140e6fc1d5677dcc9e5144c",
    url: "https://github.com/simplex-chat/simplexmq/releases/download/v6.5.0/smp-server-ubuntu-24_04-x86-64" },
  simplexChat: { file: "simplex-chat-7.0.3-ubuntu-24_04.deb", sha256: "a004fb0ea97f647d9364b56f2b41f084201b3281c715f28800a5868026e81102",
    url: "https://github.com/simplex-chat/simplex-chat/releases/download/v7.0.3/simplex-chat-ubuntu-24_04-x86_64.deb" },
  ntfy: { file: "ntfy_2.28.0_linux_amd64.tar.gz", sha256: "881a1530e30e01f1dec202c7f41e1664e57edfb7844e73e21e345159ac3ea9b7",
    url: "https://github.com/binwiederhier/ntfy/releases/download/v2.28.0/ntfy_2.28.0_linux_amd64.tar.gz" },
};
const gotifyAdmin = { user: "admin", pass: "branch-real-chat-admin" };

function run(command, args, { input, cwd } = {}) {
  const done = spawnSync(command, args, { input, cwd, encoding: "utf8", windowsHide: true });
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${done.stderr || done.stdout}`);
  return done.stdout;
}
/** A root shell in the WSL distro; `input` becomes the script's stdin. */
const wsl = (script, input) => run("wsl.exe", ["-d", distro, "-u", "root", "-e", "bash", "-c", script], { input });
/** Windows' own tar (bsdtar), which reads zip; the tar on PATH may be Git's, which does not. */
const systemTar = join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
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
function startDetached(command, args, cwd, env = {}) {
  const child = spawn(command, args, { cwd, detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, ...env } });
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
  if (!existsSync(join(dir, "ergo.exe"))) run(systemTar, ["-xf", zip], { cwd: home });
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
    // Delta Chat gets mailboxes of its own, so its encrypted mail never meets the plain email walk's.
    "-Dgreenmail.users=branch:branchpw@branch.localhost,sam:sampw@branch.localhost,dcbot:dcbotpw@branch.localhost,dcsam:dcsampw@branch.localhost", "-Dgreenmail.users.login=email",
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
  aptInstall("prosody", "prosody");
  aptInstall("zstd", "zstd"); // for unpacking tuwunel
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

/** An apt package in the WSL distro, its own service kept from starting during the install and left off. */
function aptInstall(pkg, command) {
  wsl(`set -e; command -v ${command} >/dev/null && exit 0
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${pkg} >/dev/null; rm -f /usr/sbin/policy-rc.d
systemctl disable --now ${pkg} >/dev/null 2>&1 || true`);
}
/** MQTT: Mosquitto from apt, one loopback listener, no accounts (the topics are the test's own). */
async function mqttUp() {
  aptInstall("mosquitto", "mosquitto");
  const config = `# Branch real-chat harness: a throwaway MQTT broker on this computer only.
listener ${ports.mqtt} 127.0.0.1
allow_anonymous true
persistence false
`;
  wsl(`set -e; mkdir -p ${inWsl}; cat > ${inWsl}/mosquitto.conf
setsid -f mosquitto -c ${inWsl}/mosquitto.conf > ${inWsl}/mosquitto.log 2>&1 < /dev/null`, config);
  await listening(ports.mqtt, "Mosquitto");
  return { state: { host: "127.0.0.1", port: ports.mqtt } };
}
/** Gotify: one Windows binary with SQLite, loopback only; its admin account exists only here. */
async function gotifyUp() {
  const zip = await fetchPinned(downloads.gotify);
  const dir = join(home, "gotify");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "gotify-windows-amd64.exe"))) run(systemTar, ["-xf", zip], { cwd: dir });
  const pid = startDetached(join(dir, "gotify-windows-amd64.exe"), [], dir, {
    GOTIFY_SERVER_LISTENADDR: "127.0.0.1", GOTIFY_SERVER_PORT: String(ports.gotify), GOTIFY_DATABASE_DIALECT: "sqlite3",
    GOTIFY_DATABASE_CONNECTION: "gotify.db", GOTIFY_DEFAULTUSER_NAME: gotifyAdmin.user, GOTIFY_DEFAULTUSER_PASS: gotifyAdmin.pass,
    GOTIFY_UPLOADEDIMAGESDIR: "images", GOTIFY_PLUGINSDIR: "plugins" });
  await listening(ports.gotify, "Gotify", pid);
  return { pid, state: { base: `http://127.0.0.1:${ports.gotify}`, admin: gotifyAdmin } };
}
/**
 * ntfy: its server does not run on Windows, so the Linux binary runs in the WSL distro, loopback only, open topics.
 * Loopback is exempt from its request limit: the test and Branch both poll, and a public server would limit that.
 */
async function ntfyUp() {
  const archive = await fetchPinned(downloads.ntfy);
  const placed = spawnSync("wsl.exe", ["-d", distro, "-u", "root", "-e", "test", "-x", `${inWsl}/ntfy/ntfy`], { windowsHide: true }).status === 0;
  if (!placed) wsl(`set -e; mkdir -p ${inWsl}/ntfy; cd ${inWsl}/ntfy; tar -xzf - --strip-components=1 ntfy_2.28.0_linux_amd64/ntfy`, readFileSync(archive));
  wsl(`set -e; cd ${inWsl}/ntfy; setsid -f ./ntfy serve --listen-http 127.0.0.1:${ports.ntfy} --base-url http://127.0.0.1:${ports.ntfy} \
  --visitor-request-limit-exempt-hosts 127.0.0.1 \
  --cache-file ${inWsl}/ntfy/cache.db > ${inWsl}/ntfy.log 2>&1 < /dev/null`);
  await listening(ports.ntfy, "ntfy");
  return { state: { base: `http://127.0.0.1:${ports.ntfy}` } };
}
/** Mumble: the apt server (7.5 MB with its libraries), loopback only, its own self-signed certificate, no Ice. */
async function mumbleUp() {
  aptInstall("mumble-server", "mumble-server");
  const config = `; Branch real-chat harness: a throwaway Mumble server on this computer only.
database=${inWsl}/mumble/mumble.sqlite
logfile=${inWsl}/mumble/mumble.log
host=127.0.0.1
port=${ports.mumble}
users=10
bonjour=false
ice=
welcometext=
`;
  wsl(`set -e; mkdir -p ${inWsl}/mumble; cat > ${inWsl}/mumble/mumble.ini; chown -R mumble-server ${inWsl}/mumble
setsid -f runuser -u mumble-server -- mumble-server -ini ${inWsl}/mumble/mumble.ini -fg > /dev/null 2>&1 < /dev/null`, config);
  await listening(ports.mumble, "Mumble");
  return { state: { host: "127.0.0.1", port: ports.mumble } };
}
/** Delta Chat: no server of its own. The rpc program (one Windows binary) talks to GreenMail above. */
async function deltachatUp() {
  const path = await fetchPinned(downloads.deltachat);
  return { state: { path, domain: "branch.localhost", smtp: { host: "127.0.0.1", port: ports.smtp }, imap: { host: "127.0.0.1", port: ports.imap } } };
}
/**
 * Nostr: nak (one Windows binary) serves an in-memory relay on loopback. The same program is the person's client in
 * the test: it makes keys, encrypts direct messages and talks to the relay, and shares no code with Branch.
 */
async function nostrUp() {
  const nak = await fetchPinned(downloads.nak);
  const pid = startDetached(nak, ["serve", "--hostname", "127.0.0.1", "--port", String(ports.nostr)], home);
  await listening(ports.nostr, "nak relay", pid);
  return { pid, state: { relay: `ws://127.0.0.1:${ports.nostr}`, nak } };
}
/**
 * SimpleX: its relay (smp-server) cannot bind one address, so it runs in a network namespace of its own with the
 * assistant's and the person's simplex-chat programs, and nothing there is reachable from outside the distro. Each
 * program's API (which binds 127.0.0.1 itself) is bridged to Windows by socat on a loopback port.
 */
async function simplexUp() {
  aptInstall("socat", "socat");
  const dir = `${inWsl}/simplex`, has = (path) => spawnSync("wsl.exe", ["-d", distro, "-u", "root", "-e", "test", "-x", path], { windowsHide: true }).status === 0;
  if (!has(`${dir}/smp-server`)) wsl(`set -e; mkdir -p ${dir}; cat > ${dir}/smp-server; chmod +x ${dir}/smp-server`, readFileSync(await fetchPinned(downloads.smp)));
  if (!has(`${dir}/deb/usr/bin/simplex-chat`)) wsl(`set -e; mkdir -p ${dir}; cat > ${dir}/chat.deb; dpkg-deb -x ${dir}/chat.deb ${dir}/deb`, readFileSync(await fetchPinned(downloads.simplexChat)));
  const run = `ip netns exec branch-sx env SMP_SERVER_CFG_PATH=${dir}/etc SMP_SERVER_LOG_PATH=${dir}/var`;
  wsl(`set -e; cd ${dir}
ip netns add branch-sx 2>/dev/null || true; ip netns exec branch-sx ip link set lo up
[ -f etc/fingerprint ] || ${run} ./smp-server init --ip 127.0.0.1 --no-password --disable-web -y > /dev/null
sed -i 's/^port = .*/port = 17223/; s/^host = .*/host = 127.0.0.1/' etc/smp-server.ini
setsid -f ${run} ./smp-server start > ${dir}/smp.log 2>&1 < /dev/null
relay="smp://$(cat etc/fingerprint)@127.0.0.1:17223"; rm -rf bot person; mkdir -p bot person
setsid -f ip netns exec branch-sx ./deb/usr/bin/simplex-chat -d ${dir}/bot/db --create-bot-display-name Branch -s "$relay" -p 5225 > bot.log 2>&1 < /dev/null
setsid -f ip netns exec branch-sx ./deb/usr/bin/simplex-chat -d ${dir}/person/db --user-display-name sam -s "$relay" -p 5226 > person.log 2>&1 < /dev/null
setsid -f socat TCP-LISTEN:${ports.simplexBot},bind=127.0.0.1,reuseaddr,fork "SYSTEM:ip netns exec branch-sx socat STDIO TCP\\:127.0.0.1\\:5225" > /dev/null 2>&1 < /dev/null
setsid -f socat TCP-LISTEN:${ports.simplexPerson},bind=127.0.0.1,reuseaddr,fork "SYSTEM:ip netns exec branch-sx socat STDIO TCP\\:127.0.0.1\\:5226" > /dev/null 2>&1 < /dev/null`);
  await listening(ports.simplexBot, "SimpleX bridge");
  await listening(ports.simplexPerson, "SimpleX bridge");
  return { state: { assistant: `ws://127.0.0.1:${ports.simplexBot}`, person: `ws://127.0.0.1:${ports.simplexPerson}` } };
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
  const starters = { irc: ircUp, email: emailUp, xmpp: xmppUp, matrix: matrixUp, mqtt: mqttUp, gotify: gotifyUp, ntfy: ntfyUp,
    mumble: mumbleUp, deltachat: deltachatUp, nostr: nostrUp, simplex: simplexUp };
  const state = { pids: [], servers: {} };
  try {
    for (const [name, start] of Object.entries(starters)) {
      const started = await start();
      if (started.pid) state.pids.push(started.pid);
      state.servers[name] = started.state;
      writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`); // written as it goes, so down can always stop what started
    }
  } catch (error) {
    down({ quiet: true });
    throw error;
  }
  console.log(`Up. State in ${stateFile}. Run: node scripts/real-chat/servers.mjs test`);
}
function down({ quiet = false } = {}) {
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { pids: [] };
  for (const pid of state.pids ?? []) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  spawnSync("wsl.exe", ["-d", distro, "-u", "root", "-e", "bash", "-c",
    `pkill -f '${inWsl}/[p]rosody.cfg.lua' ; pkill -f '[t]uwunel -c tuwunel.toml' ; pkill -f '${inWsl}/[m]osquitto.conf' ; pkill -f '[n]tfy serve --listen-http' ; pkill -f '${inWsl}/mumble/[m]umble.ini' ; pkill -f '[s]ocat TCP-LISTEN:1522' ; ip netns pids branch-sx 2>/dev/null | xargs -r kill ; sleep 0.5 ; ip netns del branch-sx 2>/dev/null ; true`], { windowsHide: true });
  if (existsSync(stateFile)) writeFileSync(stateFile, `${JSON.stringify({ servers: {} })}\n`);
  if (!quiet) console.log("Down.");
}
function test() {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const file = join(repo, "tests", "real-chat.test.mjs");
  if (!existsSync(file)) throw new Error(`${file} is missing`);
  const done = spawnSync(process.execPath, ["--test", "--test-timeout=300000", file], { cwd: repo, stdio: "inherit",
    env: { ...process.env, BRANCH_REAL_CHAT_STATE: stateFile, NODE_EXTRA_CA_CERTS: state.servers.xmpp?.ca ?? "" } });
  process.exitCode = done.status ?? 1;
}

const command = process.argv[2];
if (command === "up") await up();
else if (command === "down") down();
else if (command === "test") test();
else { console.error("Usage: node scripts/real-chat/servers.mjs up|test|down"); process.exitCode = 2; }
