/**
 * One fixed task, the way the owner's Hermes Agent screenshot shows work in Telegram, as Branch's own live-step lines
 * (src/live-steps.ts LiveStep): file searches, a long search pattern, commands (one a Python heredoc), writing a file,
 * running a script, a patch, reading notes, a background program and a memory update, with a repeat to fold.
 * Used by the steps-display and every-channel rendering tests. Nothing here is a real task.
 */
import { STEP_ICONS } from "../dist/live-steps.js";

let serial = 0;
const running = (command) => ({ key: "window.chat.live.running", values: { command } });
export function step({ tool, icon, label, path, say, input, state = "done", result = null, depth = 0 }) {
  return { id: `s${++serial}`, kind: "tool", icon, label, result, state, at: new Date(0).toISOString(), seconds: 1, depth,
    input: input ?? null, output: null, tool, ...(path ? { path } : {}), ...(say ? { say: { label: say } } : {}) };
}
export const heredoc = "python3 - <<'PY'\nimport json\nprint(json.dumps({'ok': True}))\nPY";
export const longPattern = "repair-routing|repair_routing|delete_routing|gateway_routing|website-pusher|sessions.json|SessionDB";
export const deepPath = "workspace/hermes-data/tmp/hermes-route-repair/verification/output/hermes-verify-route-repair.py";
export function screenshotSteps() {
  serial = 0;
  return [
    step({ tool: "files.grep", icon: STEP_ICONS.find, label: "Searching files for state.db" }),
    step({ tool: "files.grep", icon: STEP_ICONS.find, label: `Searching files for ${longPattern}` }),
    step({ tool: "shell.execute", icon: STEP_ICONS.command, label: "Running python3", say: running(heredoc),
      input: JSON.stringify({ executable: "python3", args: ["-"] }) }),
    step({ tool: "files.write", icon: STEP_ICONS.write, label: `Writing ${deepPath}`, path: deepPath,
      input: JSON.stringify({ path: deepPath, content: "print(1)" }) }),
    step({ tool: "code.run", icon: STEP_ICONS.code, label: "Running code", input: JSON.stringify({ language: "python", source: "from hermes_tools import write_file\nwrite_file('a', 'b')" }) }),
    step({ tool: "files.patch", icon: STEP_ICONS.edit, label: "Editing notes/routes.md", path: "notes/routes.md" }),
    step({ tool: "files.grep", icon: STEP_ICONS.find, label: "Searching files for website-pusher" }),
    step({ tool: "files.grep", icon: STEP_ICONS.find, label: "Searching files for website-pusher" }),
    step({ tool: "shell.execute", icon: STEP_ICONS.command, label: "Running ps", say: running("ps -o pid,ppid,stat,etime,%cpu,%mem,command -p 4242") }),
    step({ tool: "files.read", icon: STEP_ICONS.read, label: "Reading MEMORY.md", path: "MEMORY.md" }),
    step({ tool: "files.read", icon: STEP_ICONS.read, label: "Reading USER.md", path: "USER.md" }),
    step({ tool: "process.read", icon: STEP_ICONS.process, label: "Checking proc_21edec94482" }),
    step({ tool: "memory.save", icon: STEP_ICONS.memory, label: "Updating memory" }),
  ];
}
export const screenshotView = () => ({ steps: screenshotSteps(), seconds: 42 });
