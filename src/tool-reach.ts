/**
 * Q59: whether a tool reaches beyond this computer's workspace, classified by what the tool does.
 *
 *   local     it works on the workspace, Branch's own records, or reads something on this computer
 *   outbound  it sends a request over the network (a website, a mail or calendar service, another
 *             computer or device, an outside memory or model service a tool of its own talks to),
 *             or it acts on a web page or on another program's window
 *
 * A request to the owner's own model connection is how Branch thinks, not a web action, so a tool
 * that only asks the model (describing a picture, summarising a document) is local.
 *
 * Ask first, Plan and Auto ask before every outbound tool (src/conversation-mode.ts). The class is
 * worked out from the tool's permission; a tool whose permission does not say enough declares
 * `reach` itself in its definition (src/contracts.ts). A permission missing from the table below,
 * and a tool from somebody else (an MCP server, a plugin, a program lending tools), counts as
 * outbound: Branch cannot see what it does. tests/conversation-mode-order.test.mjs fails while any
 * registered tool's permission is missing here, so a new permission cannot slip through unclassified.
 */
export type ToolReach = "local" | "outbound";

const outbound: readonly string[] = [
  "web.read", "research.run", "sources.sync", "api.call", "skills.http", "client.tools",
  "personal.read", "personal.write", "home.control", "gitlab.read", "issues.read", "issues.write",
  "github.manage", "git.remote", "channels.send", "blocks.run", "addons.search",
  "agents.ask", "agents.manage", "nodes.run", "nodes.read", "remote.execute", "sessions.handoff",
  "devices.act", "devices.capture", "devices.run",
  // The owner's Claude Code or Codex does a job with the owner's plan: the work goes to that program's service.
  "code.handoff",
  // Acting on a web page or on another program's window is outside the workspace too.
  "browser.interact", "signin.fill", "desktop.control", "desktop.clipboard",
];
const local: readonly string[] = [
  "files.read", "files.write", "code.execute", "shell.execute", "process.read", "process.manage",
  "git.read", "git.write", "documents.read", "documents.write", "data.read", "data.write",
  "memory.read", "memory.write", "history.read", "scratch.read", "scratch.write", "media.read", "media.write",
  "skills.read", "skills.write", "skills.manage", "workbooks.write", "specialists.read", "specialists.use", "specialists.manage",
  "trunks.message", "sessions.branch", "models.switch", "user.ask", "heartbeat.respond", "mcp.read",
  "browser.read", "desktop.view", "devices.read", "brief.read", "brief.manage", "monitors.read", "monitors.manage",
  "schedules.read", "schedules.manage", "workflows.read", "workflows.manage", "procedures.use", "procedures.manage",
  "automations.read", "automations.propose", "boards.read", "boards.write", "widgets.read", "widgets.propose",
  "installs.read", "installs.request", "intents.read", "labels.read", "labels.manage", "projects.read",
  "projects.manage", "pages.write", "forecasts.read", "forecasts.write", "leads.read", "leads.write", "research.read", "blocks.read", "sources.read", "addons.wasm", "addons.draft",
  "gateway.propose",
  // A Trunk proposal is shown to the owner in the conversation; nothing is made and nothing leaves the computer.
  "trunks.propose",
  // Branch's own settings (Q48/Q49 settings.why and settings.undo, Q50 talk) and its bundled help: nothing leaves the computer.
  "settings.read", "settings.write", "help.read",
];
const byPermission = new Map<string, ToolReach>([
  ...outbound.map((permission) => [permission, "outbound"] as const),
  ...local.map((permission) => [permission, "local"] as const),
]);

/** True when the table below says what tools with this permission do. */
export const permissionClassified = (permission: string): boolean => byPermission.has(permission);

/** What one tool reaches: somebody else's tool is outbound; then its own declaration, then its permission; unknown is outbound. */
export function reachOf(tool: { permission: string; reach?: ToolReach | undefined; external?: boolean | undefined }): ToolReach {
  if (tool.external) return "outbound";
  if (tool.reach) return tool.reach;
  return byPermission.get(tool.permission) ?? "outbound";
}
