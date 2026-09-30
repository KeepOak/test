/* A new typed branching flow. Saving uses the existing compiler; no run or overwrite route is offered. */
import { esc } from "../core/dom.js";
import { ownerHere, activeId } from "../core/state.js";
import { api } from "../core/api.js";
import { openDlg, dialog, closeDlg, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const KINDS = ["prompt", "tool", "condition", "map", "gather", "subflow"];
const TYPES = ["text", "number", "yes/no", "list of text", "list of numbers", "anything"];
let current = null;
const w = (key) => t(`window.graph-editor.${key}`);
const here = (v) => current === v && ownerHere() && activeId() === v.scope && dialog()?.querySelector("#graph-editor");
const field = (group, index, key) => `data-ge-group="${group}" data-ge-index="${index}" data-ge-key="${esc(key)}"`;
const input = (label, group, index, key, value = "", type = "text") => `<label class="field">${esc(label)}<input class="inp" type="${type}" ${type === "number" ? 'min="1" max="100" step="1"' : 'maxlength="500"'} ${field(group,index,key)} value="${esc(value)}"></label>`;
const select = (label, group, index, key, value, choices) => `<label class="field">${esc(label)}<select class="inp" ${field(group,index,key)}>${choices.map(([id,name]) => `<option value="${esc(id)}" ${id === value ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label>`;
const checkbox = (label, group, index, key, value) => `<label><input type="checkbox" ${field(group,index,key)} ${value ? "checked" : ""}> ${esc(label)}</label>`;
const remove = (group, index) => `<button class="btn ghost sm" type="button" data-act="ge-remove" data-group="${group}" data-index="${index}">${esc(t("action.remove"))}</button>`;

export function graphEditorButton() {
  return ownerHere() ? `<button class="btn" type="button" data-act="ge-open">${esc(w("title"))}</button>` : "";
}
function capture(v) {
  if (!here(v)) return;
  for (const el of dialog().querySelectorAll("[data-ge-key]")) {
    const { geGroup: group, geIndex: index, geKey: key } = el.dataset;
    const row = group === "flow" ? v : v[group]?.[Number(index)];
    if (!row) continue;
    if (key.startsWith("reads:") || key.startsWith("writes:")) {
      const [which, name] = key.split(":");
      row[which] ??= [];
      row[which] = row[which].filter((one) => one !== name);
      if (el.checked) row[which].push(name);
    } else row[key] = el.type === "checkbox" ? el.checked : el.value;
  }
}
function picture(v) {
  const positions = new Map(v.nodes.map((n,i) => [n.id, { x: 20 + (i % 3) * 230, y: 30 + Math.floor(i / 3) * 110 }]));
  const arrows = v.edges.map((e) => {
    const a = positions.get(e.from), b = positions.get(e.to);
    if (!a || !b) return "";
    const x = a.x + 95, y = a.y + 48, xx = b.x + 95, yy = b.y;
    return `<path d="M${x} ${y} C${x+70} ${y+40},${xx-70} ${yy-35},${xx} ${yy}" fill="none" stroke="var(--ink-3)" ${e.loop ? 'stroke-dasharray="5 4"' : ""} marker-end="url(#ge-arrow)"/><text x="${(x+xx)/2}" y="${(y+yy)/2}" text-anchor="middle">${esc(w(e.when))}${e.loop ? ` (${esc(w("loop"))})` : ""}</text>`;
  }).join("");
  return `<svg class="flow-svg" viewBox="0 0 710 ${Math.ceil(v.nodes.length/3)*110+40}" role="img" aria-label="${esc(w("picture"))}"><title>${esc(w("picture"))}</title><defs><marker id="ge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--ink-3)"/></marker></defs>${arrows}${v.nodes.map((n) => {
    const p = positions.get(n.id);
    return `<rect x="${p.x}" y="${p.y}" width="190" height="48" rx="${n.kind === "condition" ? 20 : 8}" fill="var(--raise)" stroke="${n.id === v.entry ? "var(--accent)" : "var(--line-2)"}"/><text x="${p.x+95}" y="${p.y+19}" text-anchor="middle">${esc(n.name.slice(0,24))}</text><text x="${p.x+95}" y="${p.y+37}" text-anchor="middle">${esc(w(n.kind))}</text>`;
  }).join("")}</svg>`;
}
function nodeCard(v,n,i) {
  const values = [["", w("choose")], ...v.fields.filter((f) => f.name).map((f) => [f.name, f.name])];
  let extra = "";
  if (["prompt","map"].includes(n.kind)) extra += `<label class="field">${esc(w("instruction"))}<textarea class="inp" ${field("nodes",i,"prompt")} maxlength="8000">${esc(n.prompt ?? "")}</textarea></label>`;
  if (n.kind === "tool") extra += input(w("tool-name"),"nodes",i,"tool",n.tool) + `<label class="field">${esc(w("arguments"))}<textarea class="inp" ${field("nodes",i,"argsText")}>${esc(n.argsText ?? "{}")}</textarea></label>`;
  if (n.kind === "condition") extra += select(w("value"),"nodes",i,"field",n.field,values) + input(w("contains"),"nodes",i,"contains",n.contains);
  if (["map","gather"].includes(n.kind)) extra += select(w("list"),"nodes",i,"overField",n.overField,values) + select(w("destination"),"nodes",i,"intoField",n.intoField,values);
  if (n.kind === "subflow") extra += input(w("flow-id"),"nodes",i,"flowId",n.flowId);
  const uses = ["reads","writes"].map((which) => `<fieldset><legend>${esc(w(which))}</legend>${v.fields.filter((f) => f.name).map((f) => checkbox(f.name,"nodes",i,`${which}:${f.name}`,n[which]?.includes(f.name))).join(" ")}</fieldset>`).join("");
  return `<details open><summary>${esc(n.name || n.id)}</summary>${input(w("name"),"nodes",i,"name",n.name)}${select(w("kind"),"nodes",i,"kind",n.kind,KINDS.map((k) => [k,w(k)]))}${extra}${uses}${remove("nodes",i)}</details>`;
}
function draw(v) {
  if (current !== v || !ownerHere() || activeId() !== v.scope) return;
  const nodes = v.nodes.map((n) => [n.id,n.name || n.id]);
  openDlg({ title: w("title"), wide: true, body: `<div id="graph-editor"><p class="hint">${esc(w("purpose"))}</p><fieldset ${v.busy ? "disabled" : ""}>
    ${input(w("name"),"flow",0,"name",v.name)}${input(w("description"),"flow",0,"description",v.description)}${select(w("entry"),"flow",0,"entry",v.entry,nodes)}${input(w("limit"),"flow",0,"loopLimit",v.loopLimit,"number")}
    <h3>${esc(w("fields"))}</h3><p class="hint">${esc(w("fields-help"))}</p>${v.fields.map((f,i) => `<div class="rows">${input(w("name"),"fields",i,"name",f.name)}${select(w("type"),"fields",i,"type",f.type,TYPES.map((type,j) => [type,w(`type-${j}`)]))}${checkbox(w("optional"),"fields",i,"optional",f.optional)} ${checkbox(w("given"),"fields",i,"given",f.given)} ${remove("fields",i)}</div>`).join("")}<button class="btn sm" type="button" data-act="ge-add" data-group="fields" ${v.fields.length >= 100 ? "disabled" : ""}>${esc(w("add-field"))}</button>
    <h3>${esc(w("picture"))}</h3>${picture(v)}<button class="btn ghost sm" type="button" data-act="ge-redraw">${esc(w("redraw"))}</button>
    <h3>${esc(w("nodes"))}</h3>${v.nodes.map((n,i) => nodeCard(v,n,i)).join("")}<button class="btn sm" type="button" data-act="ge-add" data-group="nodes" ${v.nodes.length >= 40 ? "disabled" : ""}>${esc(w("add-node"))}</button>
    <h3>${esc(w("edges"))}</h3>${v.edges.map((e,i) => `<div class="rows">${select(w("from"),"edges",i,"from",e.from,nodes)}${select(w("to"),"edges",i,"to",e.to,nodes)}${select(w("when"),"edges",i,"when",e.when,["always","matched","otherwise"].map((k) => [k,w(k)]))}${checkbox(w("loop"),"edges",i,"loop",e.loop)}${remove("edges",i)}</div>`).join("")}<button class="btn sm" type="button" data-act="ge-add" data-group="edges" ${v.edges.length >= 80 ? "disabled" : ""}>${esc(w("add-edge"))}</button></fieldset>${v.error ? `<p role="alert">${esc(v.error)}</p>` : ""}</div>`, foot: `<button class="btn ghost" type="button" data-act="dlg-close">${esc(t("action.cancel"))}</button><button class="btn pri" type="button" data-act="ge-save" ${v.busy ? "disabled" : ""}>${esc(w("save"))}</button>` });
}
function definition(v) {
  const state = {}, inputShape = {}, names = new Set();
  for (const f of v.fields) {
    if (!/^[a-z][A-Za-z0-9_]{0,39}$/.test(f.name) || names.has(f.name)) throw new Error(w("field-error"));
    names.add(f.name);
    state[f.name] = `${f.type}${f.optional ? "?" : ""}`;
    if (f.given) inputShape[f.name] = state[f.name];
  }
  const shape = (chosen) => Object.fromEntries((chosen ?? []).filter((name) => names.has(name)).map((name) => [name,state[name]]));
  const nodes = v.nodes.map((n) => {
    const base = { id:n.id, name:n.name, kind:n.kind, input:shape(n.reads), output:shape(n.writes) };
    if (["prompt","map"].includes(n.kind)) base.prompt = n.prompt ?? "";
    if (n.kind === "tool") {
      base.tool = n.tool ?? "";
      try {
        base.args = JSON.parse(n.argsText || "{}");
        if (!base.args || typeof base.args !== "object" || Array.isArray(base.args)) throw new Error();
      } catch { throw new Error(w("args-error")); }
    }
    if (n.kind === "condition") Object.assign(base,{ field:n.field ?? "", contains:n.contains ?? "" });
    if (["map","gather"].includes(n.kind)) Object.assign(base,{ overField:n.overField ?? "", intoField:n.intoField ?? "" });
    if (n.kind === "subflow") base.flowId = n.flowId ?? "";
    return base;
  });
  return { name:v.name, description:v.description, input:inputShape, state, entry:v.entry, nodes, edges:v.edges.map((e) => ({...e})), loopLimit:Number(v.loopLimit) };
}
async function save() {
  const v = current;
  if (!v || !here(v) || v.busy) return;
  capture(v);
  let body;
  try { body = definition(v); } catch (error) { v.error = error.message; draw(v); return; }
  v.busy = true; v.error = ""; draw(v);
  try {
    await api("flows",body);
    if (!here(v)) return;
    current = null; closeDlg(); toast(w("saved"));
  } catch (error) { if (here(v)) v.error = error.message; }
  finally { v.busy = false; if (here(v)) draw(v); }
}
export function initGraphEditor() {
  markLive(["ge-open","ge-add","ge-remove","ge-redraw","ge-save"]);
  on("ge-open", () => {
    if (!ownerHere()) return;
    current = { scope:activeId(), name:"", description:"", entry:"box1", loopLimit:10, fields:[], nodes:[{id:"box1",name:"",kind:"prompt",reads:[],writes:[]}], edges:[], next:2, busy:false, error:"" };
    draw(current);
  });
  on("ge-add", (el) => {
    const v = current, group = el.dataset.group;
    if (!v || !here(v) || v.busy) return;
    capture(v);
    if (group === "fields" && v.fields.length < 100) v.fields.push({name:"",type:"text",given:false,optional:false});
    else if (group === "nodes" && v.nodes.length < 40) v.nodes.push({id:`box${v.next++}`,name:"",kind:"prompt",reads:[],writes:[]});
    else if (group === "edges" && v.edges.length < 80) v.edges.push({from:v.entry,to:v.nodes.at(-1).id,when:"always",loop:false});
    draw(v);
  });
  on("ge-remove", (el) => {
    const v = current, group = el.dataset.group, i = Number(el.dataset.index);
    if (!v || !here(v) || v.busy || !["fields","nodes","edges"].includes(group) || !v[group][i]) return;
    capture(v);
    if (group === "nodes") {
      if (v.nodes.length === 1) return;
      const id = v.nodes[i].id;
      v.edges = v.edges.filter((edge) => edge.from !== id && edge.to !== id);
      if (v.entry === id) v.entry = v.nodes.find((n) => n.id !== id).id;
    }
    v[group].splice(i,1); draw(v);
  });
  on("ge-redraw", () => { if (current && here(current) && !current.busy) { capture(current); draw(current); } });
  on("ge-save",save);
  document.addEventListener("change", (e) => {
    if (e.target.dataset.geKey !== "kind" || !current || !here(current) || current.busy) return;
    capture(current); draw(current);
  });
}
