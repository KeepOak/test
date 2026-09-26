/* Flows: setup, account wizard, chat apps, pairing, local models, connectors, tour. */

import * as account from "./account.js";
import * as setup from "./setup.js";
import * as tour from "./tour.js";
import * as chat from "./chat.js";
import * as pair from "./pair.js";
import * as connectors from "./connectors.js";
import * as whatsnew from "./whatsnew.js";
import * as trunk from "./trunk.js";
import * as flowEditor from "./flow-editor.js";
import * as prompts from "./prompts.js";
import * as computers from "./computers.js";
import * as guides from "./guides.js";
import { S, E } from "../core/state.js";
import { onRender } from "../core/dom.js";

let firstRunChecked = false;

export function init() {
  account.init();
  setup.init();
  tour.init();
  chat.init();
  pair.init();
  connectors.init();
  whatsnew.init();
  trunk.init();
  flowEditor.init();
  prompts.init();
  computers.init();
  guides.init();
  onRender(checkFirstRun);
}

/* Setup opens on the first draw while the engine says it is due (GET /api/state onboarding): not finished, not skipped,
   tips and pop-ups on, and either not done (a real model's first answer ends the first run, src/onboarding.ts) or still
   open where the person left it (a reload in the middle of setup goes back to it). It is decided in the same frame as that first draw, and until setup is drawn
   over it the window shows only its plain background (#app.ob-due), so a reload goes straight to setup, at the step
   the person was on, with no glimpse of the window first. An automated test marks it done through the engine
   (POST /api/onboarding {done: true}) before it opens the window. */
/* Windows from before setup was kept by the engine noted "seen" in this browser; that note counts only while the
   engine has no record of setup at all. */
const legacySeen = (p) => {
  if (p.step != null || (p.completed ?? []).length || p.skipped) return false;
  try { return !!localStorage.getItem("branch-setup-seen"); } catch (error) { return false; }
};
function setupDue() {
  const p = E.state?.onboarding;
  return !!p?.mine && (!p.done || p.step != null) && !p.finishedAt && !p.skipped && p.popups !== false && !legacySeen(p) && !S.ob && !/(^|[#&])(open|task)=/.test(location.hash);
}
function checkFirstRun() {
  if (firstRunChecked || !E.state) return;
  firstRunChecked = true;
  if (!setupDue()) return;
  const root = document.getElementById("app");
  root?.classList.add("ob-due");
  const show = () => root?.classList.remove("ob-due");
  setTimeout(show, 4000); // an engine that is slow to answer never leaves the window blank
  setup.openSetup(1, "resume").finally(show);
}

export function openAddAcct(prov) {
  account.openAddAcct(prov);
}

export function openSetup() {
  setup.openSetup();
}

export function startTour() {
  tour.startTour();
}

export function openChatWizard(id) {
  chat.openChatWizard(id);
}
