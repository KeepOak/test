/* Which area draws which view. Every area module exports draw() (the HTML for #main), and may export after(main) (work
   after the draw) and init() (register its actions once). */

import * as chat from "./chat/chat.js";
import * as inbox from "./places/inbox.js";
import * as automations from "./places/automations.js";
import * as library from "./places/library.js";
import * as customize from "./places/customize.js";
import * as team from "./places/team.js";
import * as overview from "./places/overview.js";
import * as settings from "./settings/settings.js";
import * as flows from "./flows/flows.js";
import * as first from "./flows/first.js";

const AREAS = { chat, inbox, automations, library, customize, team, overview, settings };
for (const area of [...Object.values(AREAS), flows, first]) area.init?.();

export const VIEWS = Object.fromEntries(Object.entries(AREAS).map(([view, area]) => [view, area.draw]));
VIEWS.after = Object.fromEntries(Object.entries(AREAS).filter(([, area]) => area.after).map(([view, area]) => [view, area.after]));
