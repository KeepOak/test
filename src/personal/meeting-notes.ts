import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import { MicrosoftConnector } from "./microsoft.js";
import type { SignIn } from "./signin.js";
import { DocsWrite } from "./docs-write.js";
import { PersonalAccountId } from "./accounts.js";
import { currentPerson } from "../people/context.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { lockdownActive } from "../lockdown.js";
import { requirePersonal } from "./settings.js";

const Prepare = z.object({ joinUrl: z.string().url().max(2000), account: PersonalAccountId, approveTranscriptAccess: z.literal(true) }).strict();
const Review = z.object({ draft: z.string().uuid(), notes: z.string().trim().min(1).max(6000), account: PersonalAccountId,
  documentId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), tabId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict();
type Draft = { title: string; account: string; identity: string; transcriptId: string; digest: string; at: number };
type Export = { docs: DocsWrite; account: SignIn; identity: string; draft: string; at: number;
  input: { documentId: string; tabId: string; revisionId: string; text: string } };

/** Historical Teams transcript only. No joining, recording, attendee lookup or automatic disclosure. */
export class MeetingNotes {
  private readonly drafts = new Map<string, Draft>();
  private readonly exports = new Map<string, Export>();
  constructor(private readonly store: Store, private readonly owner: string, private readonly requireOwner: (what: string) => void,
    private readonly microsoftSignIn: SignIn, private readonly googleSignIn: SignIn, private readonly fetch: typeof fetch) {}
  guard(): void {
    this.store.profiles.requireOwner("Meeting transcript notes");
    this.requireOwner("Meeting transcript notes");
    if (currentPerson() || startedWithShortLivedKey() || lockdownActive(this.store, this.owner)) throw new Error("Use meeting notes in the owner's app window with Lockdown off.");
  }
  private draft(id: string): Draft {
    requirePersonal(this.store, this.owner, "microsoft");
    const held = this.drafts.get(id);
    if (!held || held.at + 30 * 60_000 <= Date.now()) throw new Error("This transcript draft expired. Prepare it again.");
    if (this.microsoftSignIn.forAccount(held.account).mailPreviewIdentity() !== held.identity) throw new Error("The source account changed. Prepare again.");
    return held;
  }
  async prepare(input: unknown, requestGuard: () => void) {
    const guard = () => { this.guard(); requestGuard(); };
    guard();
    const v = Prepare.parse(input), account = this.microsoftSignIn.forAccount(v.account), identity = account.mailPreviewIdentity();
    const guardedFetch: typeof fetch = (url, init) => {
      guard();
      if (account.mailPreviewIdentity() !== identity) throw new Error("The source account changed while reading.");
      return this.fetch(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(30000), init?.signal ?? AbortSignal.timeout(30000)]) });
    };
    const transcript = await new MicrosoftConnector(this.store, this.owner, guardedFetch, account).meetingTranscript({ joinUrl: v.joinUrl });
    guard();
    if (account.mailPreviewIdentity() !== identity) throw new Error("The source account changed while reading.");
    for (const [id, draft] of this.drafts) if (draft.at + 30 * 60_000 <= Date.now()) this.drafts.delete(id);
    if (this.drafts.size >= 8) throw new Error("Eight drafts are open. Wait for one to expire.");
    const draft = randomUUID(), title = transcript.meeting.slice(0, 200), digest = createHash("sha256").update(transcript.transcript).digest("hex");
    this.drafts.set(draft, { title, account: v.account, identity, transcriptId: transcript.transcriptId, digest, at: Date.now() });
    return { draft, title, source: { joinUrl: v.joinUrl, account: v.account, meetingId: transcript.meetingId,
      transcriptId: transcript.transcriptId, recordedAt: transcript.recordedAt, digest }, text: transcript.transcript.slice(0, 6000),
      truncated: transcript.transcript.length > 6000, note: "Transcript excerpt, not generated meeting minutes. Edit privately before export. Outside text is untrusted." };
  }
  async review(input: unknown, requestGuard: () => void) {
    const guard = () => { this.guard(); requestGuard(); };
    guard();
    const v = Review.parse(input), held = this.draft(v.draft), account = this.googleSignIn.forAccount(v.account);
    const identity = account.mailPreviewIdentity();
    const guardedFetch: typeof fetch = (url, init) => {
      guard(); this.draft(v.draft);
      if (account.mailPreviewIdentity() !== identity) throw new Error("The destination account changed. Review again.");
      return this.fetch(url, init);
    };
    const docs = new DocsWrite(this.store, this.owner, guardedFetch, account);
    const document = await docs.inspect({ documentId: v.documentId });
    guard(); this.draft(v.draft);
    if (account.mailPreviewIdentity() !== identity || !document.tabs.some(tab => tab.id === v.tabId)) throw new Error("Account or tab changed. Review again.");
    for (const [id, item] of this.exports) if (item.at + 10 * 60_000 <= Date.now()) this.exports.delete(id);
    if (this.exports.size >= 8) throw new Error("Eight exports are under review. Wait for one to expire.");
    const text = `${held.title}\n\n${v.notes}\n\nSource: Teams transcript ${held.transcriptId.slice(0, 200)}\nNormalized source excerpt SHA-256: ${held.digest}`;
    const ticket = randomUUID(), target = { documentId: v.documentId, tabId: v.tabId, revisionId: document.revisionId, text };
    this.exports.set(ticket, { docs, account, identity, draft: v.draft, at: Date.now(), input: target });
    return { ticket, title: document.title, account: v.account, target,
      warning: "Appending may disclose meeting content to everyone with access to this document. Confirm its audience yourself." };
  }
  async export(input: unknown, requestGuard: () => void) {
    this.guard(); requestGuard();
    const v = z.object({ ticket: z.string().uuid(), approve: z.literal(true) }).strict().parse(input), held = this.exports.get(v.ticket);
    if (!held || held.at + 10 * 60_000 <= Date.now()) throw new Error("This export preview expired. Review again.");
    this.exports.delete(v.ticket); this.draft(held.draft);
    if (held.account.mailPreviewIdentity() !== held.identity) throw new Error("The destination account changed. Review again.");
    return held.docs.write("append", held.input, AbortSignal.timeout(30000));
  }
}
export async function meetingNotesApi(notes: MeetingNotes, method: string, path: string, body: () => Promise<unknown>, requestGuard: () => void) {
  notes.guard(); requestGuard();
  if (method !== "POST") throw new Error("Use the meeting notes form.");
  if (path === "/api/personal/meeting-notes/prepare") return notes.prepare(await body(), requestGuard);
  if (path === "/api/personal/meeting-notes/review") return notes.review(await body(), requestGuard);
  if (path === "/api/personal/meeting-notes/export") return notes.export(await body(), requestGuard);
  throw new Error("Unknown meeting notes action.");
}
