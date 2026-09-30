/** R17-C: fakes shared by the personal-connector tests. Nothing here dials, spawns or records. */
import { NetworkPolicy } from "../dist/network-policy.js";

/** Just the settings table and the record of what was allowed. */
export function fakeStore() {
  const rows = new Map();
  const audits = [];
  return {
    audits,
    get: (table, owner, id) => rows.has(`${table}/${owner}/${id}`) ? { data: rows.get(`${table}/${owner}/${id}`) } : undefined,
    save: (table, owner, id, data) => { rows.set(`${table}/${owner}/${id}`, data); return { data }; },
    delete: (table, owner, id) => rows.delete(`${table}/${owner}/${id}`),
    audit: { record: (owner, input) => audits.push(input) },
  };
}
export const on = (store, part, mode = "when-needed") => store.save("settings", "local", `personal-${part}`, { mode });

/**
 * A fetch that answers from a list of [pattern, reply] pairs and remembers every request. The owner's
 * network rules (a real NetworkPolicy, with `resolve` as its name lookup) decide each address first;
 * the services' own https addresses are never dialled, so an allowed request is answered from the list.
 */
export function fakeWeb(routes, resolve = async () => ["93.184.216.34"]) {
  const seen = [];
  const base = async (input, init = {}) => {
    const url = String(input instanceof URL ? input.href : input);
    const body = typeof init.body === "string" ? init.body : init.body;
    seen.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body });
    const found = routes.find(([pattern]) => pattern.test(url));
    if (!found) return new Response("{}", { status: 404 });
    const [, reply] = found;
    const answer = typeof reply === "function" ? reply(url, init) : reply;
    if (answer instanceof Response) return answer;
    return new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status: 200 });
  };
  const policy = new NetworkPolicy({}, resolve);
  const checked = async (input, init) => {
    await policy.assertAllowed(new URL(input instanceof URL ? input.href : String(input)));
    return base(input, init);
  };
  return { fetch: checked, seen, policy };
}
