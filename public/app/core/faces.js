/* your-profile: each person's name and face, the same on every tile (the person menu, the sidebar's owner row, Overview,
   Team, Settings › People, setup). From the engine's GET /api/profiles: owner.name (null until the owner gives one, when
   the role's name stands in) and every person's avatar { face: initial | emoji | photo, color, emoji, picture }. A picture
   is only a stamp there; its bytes are read once per stamp from GET /api/profiles/owner/picture or /<id>/picture (a data
   address, which the page's rules allow for pictures) and kept here until the stamp changes. `id` is a profile id, or
   null for the owner. */
import { E, roleLabel } from "./state.js";
import { api } from "./api.js";
import { esc, render } from "./dom.js";
import { hex, toast } from "./ui.js";

const OWNER = "owner";
const keyOf = (id) => id || OWNER;
const entryOf = (id) => (keyOf(id) === OWNER ? E.profiles?.owner : (E.profiles?.profiles ?? []).find((p) => p.id === id));

/* The person's own name; for the owner, the role's name until they give one. */
export const nameOf = (id) => (keyOf(id) === OWNER ? E.profiles?.owner?.name || roleLabel("owner") : entryOf(id)?.name ?? "");
export const avatarOf = (id) => entryOf(id)?.avatar ?? null;
/* The route one person's profile is read and saved through. */
export const profilePath = (id, part) => `profiles/${keyOf(id) === OWNER ? OWNER : encodeURIComponent(id)}/${part}`;

/* Pictures read, by person: { stamp, url }. A stamp not read yet is asked for once; the tile shows the initial meanwhile. */
const PICS = new Map();
function pictureOf(id, stamp) {
  const key = keyOf(id), have = PICS.get(key);
  if (have?.stamp === stamp) return have.url;
  PICS.set(key, { stamp, url: have?.url ?? "" });
  api(profilePath(id, "picture")).then((got) => {
    if (PICS.get(key)?.stamp !== stamp) return;
    PICS.set(key, { stamp, url: /^data:image\/(png|jpeg|webp|gif);base64,/.test(got.picture ?? "") ? got.picture : "" });
    render();
  }, (error) => toast(error.message));
  return have?.url ?? "";
}
/* A picture just saved or removed: its bytes are already known, so nothing is asked for again. */
export function knowPicture(id, stamp, url) { PICS.set(keyOf(id), { stamp, url }); }

const initial = (name) => String(name ?? "").trim().slice(0, 1).toUpperCase();

/* One person's face. cls is the tile's own class (the menu's "me", Team's "tav6"); css its size; extra anything inside it
   after the face (Team's status dot). A colour the person chose is drawn as the tile's background. */
export function face(id, { cls = "me", css = "", extra = "" } = {}) {
  const a = avatarOf(id), colour = hex(a?.color);
  const style = [css, colour ? `--c:${colour};background:${colour};color:#fff` : ""].filter(Boolean).join(";");
  const at = (inner, more = "") => `<span class="${cls}${more}"${style ? ` data-css="${style}"` : ""} aria-hidden="true">${inner}${extra}</span>`;
  const url = a?.face === "photo" && a.picture ? pictureOf(id, a.picture) : "";
  if (url) return at(`<img src="${esc(url)}" alt="" draggable="false">`, " face-yp photo-yp");
  if (a?.face === "emoji" && a.emoji) return at(`<i>${esc(a.emoji)}</i>`, " face-yp emoji-yp");
  return at(esc(initial(nameOf(id))));
}
