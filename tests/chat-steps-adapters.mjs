/**
 * Every chat adapter Branch has, built with stand-in settings and a recording fetch, for the every-channel steps test:
 * the ones in src/channels/connectors.ts (from each one's own settings schema), the team-chat services in
 * data/channels.json, and the ones with a bootstrap entry of their own. Nothing is started and nothing leaves this
 * computer: every web call goes to `record`, which answers like a service that accepted it.
 */
import { z } from "zod";
import { parityServices } from "../dist/channels/parity-services.js";
import { channelCatalog } from "../dist/channels/catalog.js";
import { DiscordAdapter, EmailAdapter, MatrixAdapter, MetaMessagingAdapter, SignalAdapter, SlackAdapter, TelegramAdapter,
  WebhookChatAdapter, WhatsAppAdapter } from "../dist/index.js";

const program = process.platform === "win32" ? "C:\\Tools\\program.exe" : "/usr/bin/program";
const CANDIDATES = ["AC" + "0".repeat(32), "*ABC1234", "wss://relay.service.test", "wx0123456789abcdef", "wcorp12345678",
  program, "TEST_SECRET", "service.test", "sample", "123456", "abc_def", "+15550100", "@bot:service.test", "#room",
  "user@service.test", "https://service.test/", "a1b2c3"];
function value(p) {
  if (!p) return "sample";
  if (p.default !== undefined) return p.default;
  if (p.enum) return p.enum[0];
  if (p.anyOf) return value(p.anyOf[0]);
  if (p.type === "string") {
    if (p.format === "uri" || p.format === "url") return "https://service.test/";
    if (!p.pattern) return "sample";
    const re = new RegExp(p.pattern);
    return CANDIDATES.find((c) => re.test(c) && (!p.minLength || c.length >= p.minLength) && (!p.maxLength || c.length <= p.maxLength)) ?? "sample";
  }
  if (p.type === "number" || p.type === "integer") return p.minimum ?? 1;
  if (p.type === "boolean") return false;
  if (p.type === "array") return p.minItems ? [value(p.items)] : [];
  if (p.type === "object") return sample(p);
  return "sample";
}
function sample(schema) {
  const out = {};
  for (const key of schema.required ?? []) if (schema.properties?.[key]?.default === undefined) out[key] = value(schema.properties?.[key]);
  return out;
}
/** The few settings a schema cannot suggest: a full path where the default is a bare program name. */
const OVERRIDES = { keybase: { path: program }, deltachat: { path: program } };
const SECRETS = { NOSTR_PRIVATE_KEY: "1".repeat(64) };

/** A web service that took every call: records it and answers with ids in the shapes the adapters read. */
export function recorder() {
  const calls = [];
  const fetch = async (url, init) => {
    let body = init?.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* a form or plain words */ } }
    else if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    calls.push({ url: String(url), method: init?.method ?? "GET", body, raw: typeof init?.body === "string" ? init.body : String(init?.body ?? "") });
    return new Response(JSON.stringify({ ok: true, id: "m1", ts: "1.1", event_id: "$e1", message_id: 1, result: { message_id: 1 },
      data: { id: "m1" }, messages: [{ id: "m1" }], sid: "SM1", errcode: 0 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

/** Every adapter, by kind: `{ kind, adapter, calls }`. */
export async function everyAdapter() {
  const built = [];
  const add = (adapter, calls) => built.push({ kind: adapter.kind, adapter, calls });
  for (const service of parityServices) {
    const { calls, fetch } = recorder();
    const settings = service.settings.parse({ ...sample(z.toJSONSchema(service.settings, { io: "input" })), ...OVERRIDES[service.kind] });
    const deps = { id: service.kind, fetch, assertAllowed: async () => {}, owner: "owner", dataDir: "branch-data",
      secret: async (name) => SECRETS[name] ?? (/URL|ADDRESS|HOOK/.test(name) ? "https://service.test/hook" : "stand-in-secret") };
    add(await service.build(settings, deps), calls);
  }
  for (const entry of channelCatalog().services) {
    const { calls, fetch } = recorder();
    add(new WebhookChatAdapter({ id: entry.id, entry, webhookUrl: "https://service.test/hook", token: "stand-in-secret",
      secret: "stand-in-secret", apiBase: "https://service.test/api", chatId: "room", fetch }), calls);
  }
  const core = [
    (fetch) => new TelegramAdapter({ id: "telegram", token: "1:stand-in", apiBase: "https://telegram.test", fetch }),
    (fetch) => new DiscordAdapter({ id: "discord", token: "stand-in", apiBase: "https://discord.test/api", fetch }),
    (fetch) => new SlackAdapter({ id: "slack", token: "stand-in", appToken: "stand-in", apiBase: "https://slack.test/api", fetch }),
    (fetch) => new MatrixAdapter({ id: "matrix", homeserver: "https://matrix.test", userId: "@b:matrix.test", accessToken: "stand-in", fetch }),
    (fetch) => new WhatsAppAdapter({ id: "whatsapp", phoneNumberId: "1", token: "stand-in", verifyToken: "v", appSecret: "a", apiBase: "https://graph.test", fetch }),
    () => new SignalAdapter({ id: "signal", path: program, account: "+15550100" }),
    (fetch) => new MetaMessagingAdapter({ id: "messenger", service: "messenger", pageId: "1", token: "t", verifyToken: "v", appSecret: "a", fetch }),
    (fetch) => new MetaMessagingAdapter({ id: "instagram", service: "instagram", pageId: "1", token: "t", verifyToken: "v", appSecret: "a", fetch }),
    () => new EmailAdapter({ id: "email", imap: { host: "mail.test", port: 993, user: "b@mail.test", tls: true },
      smtp: { host: "mail.test", port: 465, user: "b@mail.test", tls: true }, password: "stand-in", from: "b@mail.test", allowFrom: [] }),
  ];
  for (const make of core) { const { calls, fetch } = recorder(); add(make(fetch), calls); }
  return built;
}
