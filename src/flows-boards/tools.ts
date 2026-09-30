import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import { InputsSchema } from "../recipes.js";
import type { ToolRegistry } from "../registry.js";
import { ownersOwnTask } from "../autonomy/origin.js";
import { currentPerson } from "../people/context.js";
import type { FlowsBoards } from "./index.js";
import { registerOrchardTools } from "../orchard/tools.js";
import { boardWriter, fromChat } from "./origin.js";
import type { BoardPart } from "./settings.js";
import { WidgetSchema } from "./widgets.js";
import { InstallRequestSchema } from "./install-requests.js";

/**
 * R17-H: the assistant's side. Each part's tools are in the catalog only while its switch is not off
 * (src/flows-boards/index.ts). None of them approves anything: a widget and an install are questions
 * for the owner, and a card a Trunk posts to Orchard is only worked on once the owner says yes to it.
 */
type Registrar = (registry: ToolRegistry, boards: FlowsBoards) => void;
const id = z.string().uuid();

function writer(boards: FlowsBoards, context: ToolContext): void {
  if (!boardWriter(boards.store, context.runId))
    throw new Error("Only the owner's own work can change the board; a chat message, a key or another program cannot.");
}

/**
 * Integration review: Branch has one owner's board, widgets, flow runs and requests, whoever's task is
 * asking. A household person's task never reads them; a chat's task never reads the board, the
 * widgets or a flow's values (it may still see its own install requests, as /installs shows a chat).
 */
function reader(boards: FlowsBoards, context: ToolContext, chatToo = true): void {
  if (currentPerson() || !boards.store.profiles.isOwner())
    throw new Error("Only the owner's own work can read this; a household person's task cannot.");
  if (chatToo && !boardWriter(boards.store, context.runId))
    throw new Error("Only the owner's own work can read this; a chat message, a key or another program cannot.");
}

const timeTravel: Registrar = (registry, boards) => {
  registry.register({ name: "flow.steps", permission: "workflows.read",
    description: "Every step of one run of a saved flow, with the values it held after each step. Reading only; going back to a step is the owner's, in Automations.",
    parameters: z.object({ runId: id }).strict(),
    execute: async (args, context) => {
      reader(boards, context);
      // Q119 (NAS 911afbf): a Trunk reads the steps, and the values they held, of its own runs only; the owner's
      // or another Trunk's read as not there.
      if (context.trunk && boards.timeTravel.whose(args.runId) !== context.trunk)
        throw new Error("There is no flow run of yours with that id.");
      return boards.timeTravel.steps(args.runId);
    } });
};

const recipeChecks: Registrar = (registry, boards) => {
  registry.register({ name: "procedures.replay_checked", permission: "procedures.use",
    description: "Replay a verified saved procedure with the checks, clean-up, time limit and number of tries the owner set for it. Stops at once if the approval rules want to ask.",
    parameters: z.object({ id, inputs: InputsSchema.optional() }).strict(),
    execute: async (args, context) => boards.recipes.run(args.id, args.inputs ?? {},
      { mode: "policy", source: context.source ?? "owner", runId: context.runId, permissions: context.permissions, parent: context }) });
};

/** Orchard (src/orchard/tools.ts) replaces the shared board's tools under the same switch. */
const kanban: Registrar = (registry, boards) => registerOrchardTools(registry, boards.orchard, boards.store);

const widgets: Registrar = (registry, boards) => {
  registry.register({ name: "widgets.list", permission: "widgets.read",
    description: "The live widgets on the owner's dashboard, and the widget ideas waiting for an answer.",
    parameters: z.object({}).strict(),
    // Integration review: a frame's address opens without a key, so the model is never handed it.
    execute: async (_args, context) => (reader(boards, context), { widgets: boards.widgets.list().map(({ frame: _frame, ...widget }) => widget), waiting: boards.widgets.waiting() }) });
  registry.register({ name: "widgets.propose", permission: "widgets.propose",
    description: "Suggest a live widget: a title, a tool that only looks something up, its arguments, how often to ask again, and why. The owner says yes or no; nothing shows until then.",
    parameters: WidgetSchema,
    execute: async (args, context) => {
      if (!ownersOwnTask(boards.store, context.runId)) throw new Error("Only the owner's own conversation can suggest a widget.");
      return boards.widgets.propose(args);
    } });
};

const installs: Registrar = (registry, boards) => {
  registry.register({ name: "install.request", permission: "installs.request",
    description: "Ask the owner for a new package (npm or PyPI) or a new tool server. The public list of harmful packages is checked first; only the owner can say yes, and nothing is installed by asking.",
    parameters: InstallRequestSchema,
    execute: async (args, context) => {
      const chat = Boolean(context.runId) && fromChat(boards.store, context.runId);
      return boards.installs.request(args, chat ? "chat" : "assistant", chat ? "a chat app" : "the assistant");
    } });
  registry.register({ name: "install.requests", permission: "installs.read",
    description: "The requests for packages and tool servers, and the owner's answers. An approved one says exactly what to run or add; it is not installed.",
    parameters: z.object({}).strict(),
    execute: async (_args, context) => {
      reader(boards, context, false);
      // Integration review: a chat sees only what chats asked for, never the owner's own requests.
      const chat = Boolean(context.runId) && fromChat(boards.store, context.runId);
      return { requests: boards.installs.list().filter((item) => !chat || item.by === "chat").slice(-30) };
    } });
};

export const registrars: Record<BoardPart, Registrar | null> = {
  "time-travel": timeTravel, "recipe-checks": recipeChecks, kanban, widgets,
  "waiting-line": null, focus: null, "install-requests": installs,
};
