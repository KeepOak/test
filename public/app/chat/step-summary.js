import { t } from "../../i18n.js";

/* Hermes run-summary.ts (Nous Research, MIT) informed fixed category order and
   name-based classification. This is original Branch code using recorded completion states. */
const EDIT = new Set(["files.write", "files.edit", "files.patch", "code.patch", "code.change_set"]);
const SEARCH = new Set(["files.search", "files.grep", "files.find", "web.search", "sessions.search", "history.search"]);
const READ = new Set(["files.read", "files.read_lines", "web.fetch"]);
const RUN = new Set(["shell.execute", "shell.session.run", "remote.run", "code.run", "code.check"]);
const STATES = new Set(["done", "failed", "practice", "stopped"]);
function object(value) {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
}
function editedPaths(call, step) {
  const result = object(step.happened), input = object(call.arguments);
  if (result?.applied === false || result?.dryRun === true || input?.dryRun === true) return [];
  if (result?.added === 0 && result?.removed === 0 && !result?.created) return [];
  // Multi-file changes use the completed receipt; clipped JSON earns no file count.
  const paths = Array.isArray(result?.files) ? result.files.filter((file) => file?.created || file?.added !== 0 || file?.removed !== 0).map((file) => file?.path)
    : [result?.path ?? (["files.write", "files.edit"].includes(call.name) ? input?.path ?? input?.file_path : null)];
  return paths.filter((path) => typeof path === "string" && path).map((path) => {
    const clean = path.replaceAll("\\", "/").replace(/^\.\//, "");
    return /^[a-z]:\//i.test(clean) ? clean.toLowerCase() : clean;
  });
}
const clause = (key, count) => t(`window.chat.summary.${key}-${count === 1 ? "one" : "many"}`, { count });
export function stepSummary(calls, byCall) {
  if (calls.some((call) => !STATES.has(byCall.get(call.id)?.toolStatus))) return "";
  const files = new Set(), counts = { searched: 0, read: 0, ran: 0, used: 0, failed: 0, practice: 0, stopped: 0 };
  for (const call of calls) {
    const step = byCall.get(call.id), status = step.toolStatus, result = object(step.happened);
    if (status !== "done") { counts[status]++; continue; }
    if (result?.ok === false) { counts.failed++; continue; }
    if (EDIT.has(call.name) && result?.dryRun === true) { counts.practice++; continue; }
    if (EDIT.has(call.name)) {
      const paths = editedPaths(call, step);
      if (paths.length) paths.forEach((path) => files.add(path)); else counts.used++;
    } else if (SEARCH.has(call.name)) counts.searched++;
    else if (READ.has(call.name)) counts.read++;
    else if (RUN.has(call.name)) counts.ran++;
    else counts.used++;
  }
  const clauses = files.size ? [clause("edited", files.size)] : [];
  for (const [key, count] of Object.entries(counts)) if (count) clauses.push(clause(key, count));
  const words = clauses.join(", ");
  return words ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : "";
}
