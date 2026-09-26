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
import * as skillWrite from "./skill-write.js"; // finish-soon-a
import * as nameDevice from "./name-device.js"; // finish-soon-a
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
  skillWrite.init();
  nameDevice.init();
  onRender(checkFirstRun);
}

/* Setup opens on the first draw until the engine says onboarding is done (GET /api/state onboarding). An automated test
   marks it done through the engine (POST /api/onboarding {done: true}) before it opens the window. */
function checkFirstRun() {
  if (!firstRunChecked && E.state) {
    firstRunChecked = true;
    if (!E.state.onboarding?.done && !S.ob && !localStorage.getItem("branch-setup-seen")) {
      setTimeout(() => {
        if (!S.ob && !S.addAcct && !S.chw && S.view === "chat") {
          setup.openSetup();
        }
      }, 700);
    }
  }
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
