import { z } from "zod";
import { audit } from "../audit.js";
import { isReadOnlyPermission } from "../policy.js";
import type { Store } from "../store.js";

/**
 * mac7/chat-allowlist: what a task started by a chat message may use.
 *
 * This used to be a list of things taken away, which meant anything nobody had thought to name was
 * handed over — including the screen and keyboard, running code and stopping programs, and every
 * permission added after the list was written. It is now the other way round: a chat's task gets
 * the short list below and nothing else, so a permission added tomorrow is refused until somebody
 * decides otherwise.
 *
 * The short list is what a conversation needs to read and answer: ask the person a question, read
 * files, read what Branch remembers, look something up on the web, and read the instructions of an
 * installed skill. Searching is not its own permission — searching files is `files.read`, searching
 * memory is `memory.read`, and searching the web is `web.read`. Every one of them only looks:
 * `isReadOnlyPermission` in src/policy.ts holds for all five, and `tests/chat-allowlist.test.mjs`
 * checks that it still does.
 *
 * Integration review (mac7/chat-allowlist): `skills.read` is on the list because a skill is
 * instructions a task reads, not power it gains. Loading one hands the model words; every tool the
 * words name is still checked against this same list when it is called (`ToolRegistry.execute`), so
 * a skill can describe running a command and the command is still refused. Without it, "/commands"
 * and every skill the owner installed quietly stop working over chat, with no message saying why.
 */
export const chatSafePermissions = ["user.ask", "files.read", "memory.read", "skills.read", "web.read"] as const;

/**
 * Things a chat's task never gets, whatever the owner's settings say. Most of them the tools behind
 * them already refuse by where the task came from (`startedFromChat` in src/key-context.ts), so a
 * setting that promised them would be promising something that cannot happen; the rest are the ones
 * a chat must never have at all, because a chat app cannot prove who is typing. Commands on this
 * computer and on another are in the second group: a command can do anything the owner could.
 */
export const neverFromChat: readonly string[] = [
  "personal.read", "personal.write", "home.control", "brief.manage", "agents.manage",
  "skills.write", "skills.manage", "nodes.read", "nodes.run", "trunks.message",
  "shell.execute", "remote.execute", "channels.send",
  // Q187 (NAS 87ad19be note): preparing or widening a change to Branch's own source, and sending to GitHub.
  "git.remote",
];

/**
 * Integration review (mac7/chat-allowlist): the same things again as whole families, because a list
 * of exact names only holds until somebody adds a name to one of them. `nodes.write`,
 * `personal.sync` or `shell.session` would each have been handed to a chat by a line naming it, and
 * the name would have looked harmless in the card. Everything under these prefixes is refused,
 * whether it exists today or is added tomorrow.
 *
 * `skills.` and `brief.` are deliberately NOT families: `skills.read` is on the short list above and
 * `brief.read` is a reading permission a line may legitimately name. Those two stay exact names.
 */
export const neverFromChatFamilies: readonly string[] = [
  "devices.", "home.", "nodes.", "personal.", "remote.", "shell.", "trunks.",
];
/** Whether the owner may hand this one to a chat at all. The owner's own devices never are. */
export const grantableToChat = (permission: string): boolean =>
  !neverFromChat.includes(permission) && !neverFromChatFamilies.some((family) => permission.startsWith(family));

/** One line of the owner's list: who it is about, and what those chats may also use. */
export const ChatPermissionRuleSchema = z.object({
  /** The chat app this is about, or "*" for every one of them. */
  channel: z.string().trim().min(1).max(64).default("*"),
  /** The sender's id on that app, or "*" for everybody on it. */
  sender: z.string().trim().min(1).max(120).default("*"),
  /** The permission names those chats may also use, on top of the short list. */
  allow: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  /** Who this is, in the owner's words, so the list means something a year later. */
  note: z.string().trim().max(200).default(""),
  /**
   * mac7/chat-approvals: whether this person, on this app, may answer "yes" in the chat to a
   * question about what this same line granted. Off unless the owner turns it on, so a line saved
   * before this existed, and every line written without thinking about it, keeps the old rule: the
   * yes belongs in the window. Turning it on is a real loss of safety and the card says so —
   * whoever holds that chat account, or can pretend to be it, can approve those changes, because a
   * chat app cannot prove who is typing. It never reaches a name on `neverFromChat` and never a
   * name this line did not grant. It cannot reach a standing yes either, and does not have to try:
   * a chat message's task is a `channel` run, and `Runtime.approve` already refuses "yes always"
   * for any run the owner did not start themselves.
   */
  approvals: z.boolean().default(false),
}).strict()
  // Integration review (mac7/chat-approvals): the switch is one named person on one named app, so a
  // line written with "*" in either place never carries it. Both boxes in the card fall back to "*"
  // when left empty, which would have made the widest line there is the easiest one to tick: every
  // paired person on every app answering yes to everything any line granted. A transform rather than
  // a check that fails, because the settings are read back with `safeParse` and a refusal there
  // would silently throw away the owner's whole list. A wide line still adds what it allows; only
  // its yes is refused.
  .transform((rule) => (rule.channel === "*" || rule.sender === "*" ? { ...rule, approvals: false } : rule));
export type ChatPermissionRule = z.infer<typeof ChatPermissionRuleSchema>;
/** Whether this line is about one named person on one named app, which its yes needs and its grant does not. */
const namesOnePerson = (rule: ChatPermissionRule): boolean => rule.channel !== "*" && rule.sender !== "*";

/**
 * The owner's setting. `extras` is off on a fresh install, so a chat's task gets the short list and
 * nothing else until the owner turns it on. `rules` is not in the settings catalogue on purpose
 * (src/settings-kit/catalogue.ts): a whole-app preset or a settings file brought in from somewhere
 * else can turn the switch off, but can never write a line that hands a chat something new.
 */
export const ChatPermissionSettingsSchema = z.object({
  extras: z.boolean().default(false),
  rules: z.array(ChatPermissionRuleSchema).max(50).default([]),
}).strict();
export type ChatPermissionSettings = z.infer<typeof ChatPermissionSettingsSchema>;

const settingsKey = "chat-permissions";

export function readChatPermissionSettings(store: Store, owner: string): ChatPermissionSettings {
  const saved = ChatPermissionSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : ChatPermissionSettingsSchema.parse({});
}

/** Saves the switch, the list, or both; whatever is left out keeps the value it has. */
export function saveChatPermissionSettings(store: Store, owner: string, input: unknown): ChatPermissionSettings {
  // Integration review (mac7/chat-allowlist): only the owner writes this, and the check is here
  // rather than on the route so that every way in is covered — the route, the settings card and the
  // reset. A household person signed in on this computer is not the owner, and a line of theirs
  // would hand a chat something the owner never agreed to.
  store.profiles.requireOwner("What a chat may do beyond talking");
  const change = z.object({ extras: z.boolean().optional(), rules: z.array(ChatPermissionRuleSchema).max(50).optional() })
    .strict().parse(input ?? {});
  const next = ChatPermissionSettingsSchema.parse({ ...readChatPermissionSettings(store, owner), ...change });
  store.save("settings", owner, settingsKey, next);
  // mac7/chat-approvals: the count of lines that may answer yes from the chat is in the record too,
  // so turning that on is a change somebody reading the log can see, not a byte-identical entry.
  const answering = next.rules.filter((rule) => rule.approvals).length;
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: "what a chat message's task may use",
    reason: next.extras
      ? `${next.rules.length} line(s) on top of the ${chatSafePermissions.length} a chat always has`
        + `; ${answering} of them may answer yes from the chat`
      : "the short list only",
    outcome: "saved",
  });
  return next;
}

/** Whether a line is about this sender on this app. "*" in either place means "any". */
const covers = (rule: ChatPermissionRule, channel: string, sender: string): boolean =>
  (rule.channel === "*" || rule.channel === channel) && (rule.sender === "*" || rule.sender === sender);

/**
 * What the owner has allowed this chat and this person on top of the short list. Nothing at all
 * while the switch is off, and never one of the names a chat may not have.
 */
export function chatExtraPermissions(settings: ChatPermissionSettings, channel: string, sender: string): string[] {
  if (!settings.extras) return [];
  const named = settings.rules.filter((rule) => covers(rule, channel, sender)).flatMap((rule) => rule.allow);
  return [...new Set(named)].filter(grantableToChat);
}

/**
 * What a task started from a chat may use, out of everything registered: the short list, plus
 * whatever the owner has allowed this chat and this person. A name that is not on either list is
 * refused, including every permission added to Branch after this was written.
 */
export function chatPermissionsOf(all: readonly string[], extra: readonly string[] = []): string[] {
  const allowed = new Set<string>([...chatSafePermissions, ...extra.filter(grantableToChat)]);
  return all.filter((permission) => allowed.has(permission));
}
/**
 * What a chat with several people in it never has, whatever a line says: what Branch remembers is the owner's, read
 * or written, and a message there may be anybody's.
 */
export const neverInGroups: readonly string[] = ["memory.read", "memory.write"];
/**
 * What a chat with several people in it has only when the owner's line names that chat app (not "*") and the
 * permission itself: the owner's files and documents. A group is off by default even though a direct chat is not.
 */
export const groupsOnlyWhenNamed: readonly string[] = ["files.read", "documents.read"];
/**
 * The permissions of a group chat's task, taken after the owner's own lines are added so that no line hands back
 * what a group never has. A direct chat's permissions are returned as they are.
 */
export function forChatKind(permissions: string[], settings: ChatPermissionSettings,
  from?: { channel: string; senderId: string; chatKind?: string | undefined }): string[] {
  if (!from || from.chatKind === "direct") return permissions;
  const named = settings.extras
    ? settings.rules.filter((rule) => rule.channel === from.channel && covers(rule, from.channel, from.senderId)).flatMap((rule) => rule.allow)
    : [];
  return permissions.filter((permission) => !neverInGroups.includes(permission)
    && (!groupsOnlyWhenNamed.includes(permission) || named.includes(permission)));
}

/** Every permission on the short list only looks at things; asserted here so the list cannot drift. */
export const chatSafeListIsReadOnly = (): boolean => chatSafePermissions.every(isReadOnlyPermission);

/**
 * Integration review (mac7/chat-allowlist): who may say yes to what a chat's task stopped on.
 *
 * A line the owner wrote hands a chat something that can change things, and the promise made for it
 * is "it will ask first". That promise is worth nothing if the same chat sender can answer the ask:
 * they would be granting themselves the thing the line was careful about, in two messages instead of
 * one. So a "y" typed in a chat only answers a question about the short list every chat already has
 * — where the task could have gone ahead anyway under looser settings, and the answer costs nothing.
 * Anything a line granted is answered by the owner in the window.
 *
 * A "no" is always allowed from the chat: refusing takes nothing away, and a question nobody may
 * answer from where it was asked would leave the task waiting for ever.
 *
 * mac7/chat-approvals: the owner may lift that for one named person on one named app, by turning
 * the switch on in their line. Being away from this computer and unable to say yes to the very
 * thing they granted their own phone was the whole of the problem; the answer is a switch that
 * ships off and says out loud what it costs, not a rule that quietly holds for everybody.
 */
export function chatApprovablePermissions(
  settings: ChatPermissionSettings, channel: string, sender: string,
): string[] {
  if (!settings.extras) return [];
  // Per line, not per person: a line that may answer yes lends its yes to what that same line
  // granted and to nothing else, so two lines for one person never borrow each other's reach.
  // `namesOnePerson` again after the schema already dropped the tick from a wide line: this is the
  // gate that decides, and it must not depend on a value having been rewritten somewhere upstream.
  const named = settings.rules
    .filter((rule) => rule.approvals && namesOnePerson(rule) && covers(rule, channel, sender))
    .flatMap((rule) => rule.allow);
  return [...new Set(named)].filter(grantableToChat);
}

/**
 * Integration review (mac7/chat-approvals): what a chat is told when it types "a".
 *
 * "Yes always" writes a rule that answers every question like this one from now on, and a chat is
 * the one place that may never do it: the app cannot prove who is typing, so a standing yes given
 * there is a standing yes given by whoever holds the account. The letter used to reach
 * `Runtime.approve`, throw there, and be swallowed by the caller, which left the chat treating "a"
 * as an ordinary message and sending the single letter on to the assistant. It is answered here.
 */
export const standingYesInWindow =
  "A standing yes cannot come from a chat: \"yes always\" has to be given in the Branch app window. "
  + "Reply y to allow this one thing just this once, or n to refuse it.";

/**
 * Whether a "yes" typed in a chat may answer a question about this permission: always for the short
 * list every chat has, and otherwise only what one of this person's own switched-on lines granted.
 */
export const chatMayApprove = (permission: string, approvable: readonly string[] = []): boolean =>
  (chatSafePermissions as readonly string[]).includes(permission)
  || (approvable.includes(permission) && grantableToChat(permission));
/** What a chat is told when its yes is not enough, in one sentence and no jargon. */
export const approveInWindow = (label: string): string =>
  `That is more than a chat may do on its own, so "${label}" has to be approved in the Branch app window. `
  + "Reply n if you would rather it did not happen at all.";
