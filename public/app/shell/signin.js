/* In a browser the engine needs its session token before anything else (the desktop app signs requests itself).
   Drawn with the lock screen's look; the field and button names are the engine's ("Session token", "Connect"). */

import { esc } from "../core/dom.js";
import { token } from "../core/api.js";
import { t } from "../../i18n.js";

export function showSignIn(onDone, refusal = "") {
  document.querySelector(".lockscreen")?.remove();
  const el = document.createElement("div");
  el.className = "lockscreen";
  el.innerHTML = `<div class="inner"><span class="mark mark-full" aria-hidden="true"></span><h2>Branch</h2>
    <form class="signin-form" id="signin"><label class="fld"><span>${t("field.session-token")}</span><input class="inp" id="token" type="password" autocomplete="off" value="${esc(token.get())}"></label>
    ${refusal ? `<p class="hint" role="alert">${esc(refusal)}</p>` : ""}<button class="btn pri" type="submit">${t("action.connect")}</button></form></div>`;
  document.getElementById("app").appendChild(el);
  el.querySelector("#token").focus();
  el.querySelector("#signin").addEventListener("submit", (e) => {
    e.preventDefault();
    token.set(el.querySelector("#token").value.trim());
    el.remove();
    onDone();
  });
}
