import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { esc, render } from "../core/dom.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";

let state = null, reviewed = null, recovery = null, result = null;
let fields = { repository: "", project: "default", tokenSecret: "GITHUB_CHECKPOINT_TOKEN", publicKey: "", maxBytes: String(32 * 1024 * 1024), privateKeyFile: "", commit: "" };
const base = "deployment/github-checkpoint";
const owner = () => E.profiles?.isOwner !== false;
const field = (name, title, multiline = false) => `<label class="fld">${esc(title)}${multiline
  ? `<textarea id="gcp-${name}" rows="5">${esc(fields[name])}</textarea>`
  : `<input id="gcp-${name}" value="${esc(fields[name])}" autocomplete="off">`}</label>`;

export async function loadGithubCheckpoint() {
  if (!owner()) { state = reviewed = recovery = result = null; return; }
  try { state = await api(base); } catch (error) { state = { refused: error.message }; }
  if (!owner()) state = reviewed = recovery = result = null;
  render();
}

async function act(work) {
  if (!owner()) return;
  try { await work(); } catch (error) { toast(error.message); }
  render();
}

export function initGithubCheckpoint() {
  on("gcp-preview", () => act(async () => {
    reviewed = await api(`${base}/preview`, { repository: fields.repository.trim(), project: fields.project.trim(), tokenSecret: fields.tokenSecret.trim(), publicKey: fields.publicKey, maxBytes: Number(fields.maxBytes) });
  }));
  on("gcp-enroll", () => act(async () => {
    if (!reviewed || !document.getElementById("gcp-dedicated")?.checked || !document.getElementById("gcp-recovery-held")?.checked) throw new Error("Confirm both the dedicated private repository and your recovery key.");
    state = await api(`${base}/enroll`, { preview: reviewed.preview, confirmation: reviewed.confirmation, dedicatedRepository: true, recoveryKeyHeld: true });
    reviewed = null;
  }));
  on("gcp-disable", () => act(async () => {
    if (!window.confirm("Stop requiring an encrypted GitHub checkpoint before updates? Local safety copies will still be made.")) return;
    state = await api(`${base}/disable`, { disable: true }); reviewed = recovery = null;
  }));
  on("gcp-recover", () => act(async () => {
    recovery = await api(`${base}/recover-preview`, { privateKeyFile: fields.privateKeyFile.trim(), ...(fields.commit.trim() ? { commit: fields.commit.trim() } : {}), stageOnly: true });
  }));
  on("gcp-recover-confirm", () => act(async () => {
    if (!recovery) throw new Error("Review the exact recovery checkpoint first.");
    result = await api(`${base}/recover`, { preview: recovery.preview, confirmation: recovery.confirmation, stageOnly: true });
    recovery = null;
    fields.privateKeyFile = "";
  }));
  document.addEventListener("input", (event) => {
    const name = event.target.id?.replace(/^gcp-/, "");
    if (Object.hasOwn(fields, name)) {
      fields[name] = event.target.value;
      if (["privateKeyFile", "commit"].includes(name)) recovery = null; else reviewed = null;
    }
  });
  markLive(["gcp-preview", "gcp-enroll", "gcp-disable", "gcp-recover", "gcp-recover-confirm", ...Object.keys(fields).map((name) => `sw:gcp-${name}`), "sw:gcp-dedicated", "sw:gcp-recovery-held"]);
}

export function githubCheckpointSection() {
  if (!owner()) { state = reviewed = recovery = result = null; fields.publicKey = fields.privateKeyFile = ""; return ""; }
  if (!state) return "";
  if (state.refused) return `<div class="sec"><h2>GitHub update checkpoints</h2><p>${esc(state.refused)}</p></div>`;
  let html = `<div class="sec"><h2>GitHub update checkpoints</h2><p>Optional encrypted copies of the finalized update backup, including conversations and device-bound keys. GitHub receives ciphertext and opaque envelope metadata. Keep your matching RSA recovery private key outside Branch. Configured updates stop if the checkpoint fails; offline updates require a running, unlocked Branch.</p>`;
  if (state.enabled) {
    html += `<p>Required before updates: <b>${esc(state.repository)}</b>, repository ID ${esc(state.repositoryID)}, branch ${esc(state.branch || "branch-update-checkpoints")}.</p><p>Recovery-key fingerprint: <code>${esc(state.fingerprint)}</code></p><button type="button" class="btn" data-act="gcp-disable">Stop requiring GitHub checkpoints</button>`;
    html += `<details><summary>Recover a checkpoint</summary><p>Only the exact key file you choose is read locally. The key is never uploaded. Recovery stages a copy for review in the existing data-copy restore controls.</p>${field("privateKeyFile", "Absolute recovery private-key file path")}${field("commit", "Checkpoint commit SHA (leave empty for latest)")}<button type="button" class="btn" data-act="gcp-recover">Review recovery target</button>${recovery ? `<p>${esc(recovery.confirmation)}</p><p>Key file: ${esc(recovery.privateKeyFile)}; checkpoint: <code>${esc(recovery.commit)}</code>; recipient: <code>${esc(recovery.fingerprint)}</code>. This single-use review expires in two minutes.</p><button type="button" class="btn pri" data-act="gcp-recover-confirm">Read this key and stage this checkpoint</button>` : ""}${result ? `<p>${esc(result.message)} Copy: ${esc(result.name)}; commit: ${esc(result.commit)}.</p>` : ""}</details>`;
  } else {
    html += `<p>Create and initialize a dedicated private repository first. Store a fine-grained GitHub token for only that repository, with Contents read/write, under the exact project and secret name below. RSA public key: 3072–16384 bits. Maximum total original file bytes: 64 MiB; larger copies hold the update.</p>${field("repository", "Private repository (owner/name)")}${field("project", "Exact secret project ID")}${field("tokenSecret", "Exact GitHub token secret name")}${field("publicKey", "Recovery public key PEM (never the private key)", true)}${field("maxBytes", "Maximum original file bytes")}<button type="button" class="btn" data-act="gcp-preview">Review target and encryption</button>`;
  }
  if (reviewed) html += `<div class="ctl"><p>${esc(reviewed.confirmation)}</p><p>Private target: ${esc(reviewed.repository)}; pinned ID ${esc(reviewed.repositoryID)}; fingerprint <code>${esc(reviewed.fingerprint)}</code>; byte cap ${esc(reviewed.maxBytes)}. This preview expires in ten minutes.</p><label><input type="checkbox" id="gcp-dedicated">This repository is dedicated to encrypted backups.</label><label><input type="checkbox" id="gcp-recovery-held">I retain the matching recovery private key outside Branch.</label><button type="button" class="btn pri" data-act="gcp-enroll">Require this checkpoint before updates</button></div>`;
  return `${html}</div>`;
}
