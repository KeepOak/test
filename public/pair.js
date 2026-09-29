// The phone's side of "reach Branch from my phone": type the number shown on the computer, and this
// page asks Branch for the key that lets the app work, and this phone's own secret when Branch hands
// one back. Nothing is stored beyond this browser tab. The words follow the phone's own language
// (en, fr, es or de, from public/locales through /i18n.js), or English.
import { initLanguage, t } from "/i18n.js";

const form = document.getElementById("pair-form");
const field = document.getElementById("code");
const button = document.getElementById("submit");
const message = document.getElementById("message");
const offerId = new URLSearchParams(location.search).get("id") || "";

function say(text, bad) {
  message.textContent = text;
  message.className = bad ? "bad" : "";
}
/** This phone's language when Branch speaks it; the page has no picker of its own. */
async function startWords() {
  await initLanguage();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  button.disabled = true;
  say(t("phone.pair.connecting"), false);
  fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: offerId, code: field.value.trim() }),
  })
    .then((response) => response.json().then((body) => {
      if (!response.ok) throw new Error(body.error || t("people.error"));
      return body;
    }))
    .then((body) => {
      try {
        sessionStorage.setItem("branch-token", body.token);
        // This phone's own secret, when Branch handed one back; public/device-headers.js sends it.
        if (typeof body.deviceId === "string" && typeof body.deviceKey === "string")
          sessionStorage.setItem("branch-device", JSON.stringify({ id: body.deviceId, key: body.deviceKey }));
      } catch {
        say(t("pair.page.noStorage"), true);
        return;
      }
      say(t("pair.page.opening"), false);
      location.replace("/");
    })
    .catch((error) => {
      say(error.message, true);
      button.disabled = false;
      field.value = "";
      field.focus();
    });
});

startWords().then(() => {
  if (!offerId) say(t("pair.page.incomplete"), true);
}, (error) => say(error.message, true));
