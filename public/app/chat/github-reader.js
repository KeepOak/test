/* RES-509 partial: descriptions and conversation comments through the existing read-only tool. */
import { esc } from "../core/dom.js";
import { S, ownerHere, activeId } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { mi, openDlg, dialog, closePop } from "../core/ui.js";
import { t } from "../../i18n.js";

let page = null;
const w = (key) => t(`window.github-reader.${key}`);
const here = (p) => page === p && ownerHere() && activeId() === p.scope && S.chat === p.chat && dialog()?.querySelector("#github-reader");
const plain = (value, limit) => typeof value === "string" ? value.slice(0,limit) : "";
export const githubReaderMenu = () => ownerHere() ? mi("github-reader-open","book",w("title")) : "";
function reference(value) {
  const short = /^([A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})#([0-9]{1,9})$/.exec(value.trim());
  const url = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})\/(issues|pull)\/([0-9]{1,9})(?:[/?#].*)?$/i.exec(value.trim());
  const repo = short?.[1] ?? url?.[1], number = short?.[2] ?? url?.[3];
  if (!repo || !number || Number(number) < 1) throw new Error(w("reference-error"));
  return { issue: `${repo}#${Number(number)}`, address: `https://github.com/${repo}/${url?.[2] ?? "issues"}/${Number(number)}` };
}
function draw(p) {
  if (page !== p || !ownerHere() || activeId() !== p.scope || S.chat !== p.chat) return;
  const issue = p.result;
  const comments = Array.isArray(issue?.comments) ? issue.comments.slice(0,20) : [];
  const text = (value, limit) => `<pre data-css="white-space:pre-wrap;overflow-wrap:anywhere">${esc(plain(value,limit))}</pre>`;
  openDlg({ title:w("title"),wide:true,body:`<div id="github-reader"><p class="hint">${esc(w("purpose"))}</p><label class="field">${esc(w("reference"))}<input id="github-reader-reference" class="inp" maxlength="500" value="${esc(p.draft)}" ${p.busy ? "disabled" : ""}></label><button class="btn" type="button" data-act="github-reader-read" ${p.busy ? "disabled" : ""}>${esc(w(p.busy ? "reading" : "read"))}</button>${p.error ? `<p role="alert">${esc(p.error)}</p>` : ""}${issue ? `<section><h3>${esc(plain(issue.title,300))}</h3><p>${esc(plain(issue.reference,220))} · ${esc(plain(issue.state,40))}</p><a href="${esc(p.address)}" target="_blank" rel="noopener noreferrer">${esc(w("source"))}</a><p class="hint">${esc(w("untrusted"))}</p>${text(issue.body,20000)}<h3>${esc(w("comments"))}</h3><p class="hint">${esc(w("bounds"))}</p>${comments.length ? comments.map((c) => `<article><b>${esc(plain(c?.author,100))}</b> <small>${esc(plain(c?.at,80))}</small>${text(c?.body,4000)}</article>`).join("") : `<p>${esc(w("empty"))}</p>`}</section>` : ""}</div>` });
}
async function read() {
  const p = page;
  if (!p || !here(p) || p.busy) return;
  p.draft = dialog().querySelector("#github-reader-reference").value;
  let requested;
  try { requested = reference(p.draft); } catch (error) { p.error = error.message; draw(p); return; }
  p.busy=true; p.error=""; p.result=null; draw(p);
  try {
    const result = await api("action",{tool:"issues.get",args:{issue:requested.issue}});
    if (!here(p)) return;
    if (result?.tracker !== "github" || typeof result.reference !== "string" || result.reference.toLowerCase() !== requested.issue.toLowerCase()) throw new Error(w("response-error"));
    p.result=result; p.address=requested.address;
  } catch (error) { if (here(p)) p.error=error.message; }
  finally { p.busy=false; if (here(p)) draw(p); }
}
export function initGithubReader() {
  markLive(["github-reader-open","github-reader-read","sw:github-reader-reference"]);
  on("github-reader-open",() => {
    if (!ownerHere()) return;
    closePop(); page={scope:activeId(),chat:S.chat,draft:"",busy:false,error:"",result:null,address:""}; draw(page);
  });
  on("github-reader-read",read);
}
