/**
 * Set up a chat app, on the phone (mac7/connect), inside Settings › Chat apps › <app>: the same panel as the
 * window's, read from the paired Branch (GET /api/channel-setup/<id>). On a phone there is nothing to scan, so the
 * two square codes become two links: the store page for this phone, and the page that makes the bot. The token is
 * checked and saved by the Branch itself (POST /api/channel-setup/<id>/check); a refused one stays to be corrected.
 */
import { t } from "/i18n.js";
import { esc, phone, platform, w } from "/phone-common.js";

const V = { id: null, view: null, error: "", said: "" };
const system = () => (platform() === "ios" ? "ios" : "android");
/** A recipe's own sentence in the chosen language when the language file has it, else the engine's. */
const recipe = (part, english) => { const key = `channel-setup.r.${V.view?.id}.${part}`; return esc(t(key) === key ? english : t(key)); };
const link = (key, english, href) => (/^https?:\/\//i.test(String(href ?? "")) ? `<a class="quiet-button" href="${esc(href)}" target="_blank" rel="noreferrer noopener">${w(key, english)}</a>` : "");

function links(view) {
  const out = [];
  const store = view.stores?.[system()];
  if (store) out.push(link("phone.connect.store", "Get the app", store));
  else if (view.noApp) out.push(`<p>${recipe("noApp", view.noApp)}</p>`);
  if (view.create?.url) out.push(`<p>${recipe("how", view.create.how)}</p>`, link("phone.connect.create", "Make the bot", view.create.url));
  else if (view.create) out.push(`<p>${recipe("how", view.create.how)}</p>`, `<p>${w("phone.connect.server-first", "This one needs your own server: make the bot on the computer.")}</p>`);
  else if (view.noCreate) out.push(`<p>${recipe("noCreate", view.noCreate)}</p>`);
  return out.join("");
}
function box(name, what, type) {
  const id = `connect-${esc(name)}`;
  return `<label for="${id}">${recipe(type === "password" ? `paste-${name}` : `field-${name}`, what)}</label><input id="${id}" data-name="${esc(name)}" type="${type}" autocomplete="off" spellcheck="false">`;
}
export function drawPanel() {
  if (V.error) return `<p class="subtle bad">${esc(V.error)}</p>`;
  const view = V.view;
  if (!view) return "";
  const boxes = [...(view.fields ?? []).map((f) => box(f.name, f.what, "text")), ...(view.paste ?? []).map((p) => box(p.secret, p.what, "password"))].join("");
  // While setting up from here is switched off, the Branch refuses Check and save in its own words (409), shown as said.
  return `${links(view)}${boxes}<button type="button" id="connect-save" data-act="connect-save">${w("channel-setup.check-and-save", "Check and save")}</button><p class="subtle" id="connect-status" role="status">${esc(V.said)}</p>`;
}
export async function loadPanel(id) {
  if (!/^[a-z0-9-]+$/.test(String(id ?? ""))) return;
  if (V.id !== id) Object.assign(V, { id, view: null, error: "", said: "" });
  try { V.view = await phone.vault.request("GET", `/api/channel-setup/${id}`); V.error = ""; } catch (error) { V.error = error.message; }
}
/** Check and save: the values typed, checked by the Branch; the pasted secrets are cleared once it accepts them. */
export async function savePanel(root) {
  const values = {};
  for (const input of root.querySelectorAll("#connect-body input[data-name]")) if (input.value.trim()) values[input.dataset.name] = input.value.trim();
  const said = root.querySelector("#connect-status");
  if (said) said.textContent = t("channel-setup.checking") === "channel-setup.checking" ? "Checking…" : t("channel-setup.checking");
  try {
    const answer = await phone.vault.request("POST", `/api/channel-setup/${V.id}/check`, { values });
    for (const input of root.querySelectorAll('#connect-body input[type="password"]')) input.value = "";
    // CHAT-147: the Branch connects it as it saves; its own words say if it did not, or what is still needed.
    V.said = [answer.botName ? t("channel-setup.checked-as", { name: answer.botName }) : t("channel-setup.done"), answer.connectNote].filter(Boolean).join(" ");
  } catch (error) { V.said = error.message; }
  if (said) said.textContent = V.said;
}
