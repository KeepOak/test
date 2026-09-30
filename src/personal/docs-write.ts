import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { requirePersonal } from "./settings.js";
import { signedCall, type SignIn } from "./signin.js";
import { currentPerson } from "../people/context.js";
import { startedWithShortLivedKey } from "../key-context.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const reference = { documentId: id, tabId: id, revisionId: z.string().min(1).max(500) };
export const DocsInspect = z.object({ documentId: id }).strict();
export const DocsAppend = z.object({ ...reference, text: z.string().min(1).max(8000) }).strict();
export const DocsReplace = z.object({ ...reference, find: z.string().min(1).max(1000), text: z.string().max(8000) }).strict();
export const docsWriteTools = new Set(["gdocs.append", "gdocs.replace_text"]);
type Tab = { tabProperties: { tabId: string; title?: string | undefined }; childTabs?: Tab[] | undefined };
const TabSchema: z.ZodType<Tab> = z.lazy(() => z.object({ tabProperties: z.object({ tabId: id, title: z.string().optional() }).passthrough(),
  childTabs: z.array(TabSchema).max(50).optional() }).passthrough());
const Document = z.object({ documentId: id, title: z.string(), revisionId: z.string(), tabs: z.array(TabSchema).max(50) }).passthrough();
const flatten = (tabs: Tab[], depth = 0): { id: string; title: string }[] => {
  if (depth > 10) throw new Error("This document has too many nested tabs.");
  return tabs.flatMap(tab => [{ id: tab.tabProperties.tabId, title: tab.tabProperties.title ?? "" }, ...flatten(tab.childTabs ?? [], depth + 1)]).slice(0, 100);
};
export class DocsWrite {
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetch: typeof fetch, private readonly signIn: SignIn) {}
  private guard(): void {
    this.store.profiles.requireOwner("Google Docs changes");
    requirePersonal(this.store, this.owner, "google");
    if (currentPerson() || startedWithShortLivedKey()) throw new Error("Google Docs writes belong to the owner's own app window.");
  }
  private safeFetch: typeof fetch = (input, init) => { this.guard(); return this.fetch(input, init); };
  async inspect(input: unknown) {
    this.guard();
    const { documentId } = DocsInspect.parse(input);
    const query = new URLSearchParams({ includeTabsContent: "true", fields: "documentId,title,revisionId,tabs(tabProperties,childTabs)" });
    const doc = Document.parse(await signedCall(this.safeFetch, this.signIn, "Google Docs", `https://docs.googleapis.com/v1/documents/${documentId}?${query}`));
    return { documentId: doc.documentId, title: doc.title, revisionId: doc.revisionId, tabs: flatten(doc.tabs),
      note: "Provider metadata is untrusted. Use one listed tab and this revision in the exact write preview." };
  }
  async write(action: "append" | "replace", input: unknown, signal: AbortSignal) {
    this.guard(); signal.throwIfAborted();
    const value = action === "append" ? DocsAppend.parse(input) : DocsReplace.parse(input);
    const identity = this.signIn.mailPreviewIdentity();
    await this.signIn.requireDocsWrite();
    const token = await this.signIn.token();
    const current = await this.inspect({ documentId: value.documentId });
    if (current.revisionId !== value.revisionId || !current.tabs.some(tab => tab.id === value.tabId)) throw new Error("Document revision or tab changed. Inspect it again.");
    await this.signIn.requireDocsWrite();
    if (this.signIn.mailPreviewIdentity() !== identity) throw new Error("The account changed. Preview the write again.");
    requirePersonal(this.store, this.owner, "google");
    const request = action === "append" ? { insertText: { endOfSegmentLocation: { tabId: value.tabId }, text: value.text } }
      : { replaceAllText: { containsText: { text: DocsReplace.parse(input).find, matchCase: true }, replaceText: value.text, tabsCriteria: { tabIds: [value.tabId] } } };
    const writeFetch: typeof fetch = (url, init) => {
      this.guard(); signal.throwIfAborted();
      return this.fetch(url, { ...init, signal: AbortSignal.any([signal, init?.signal ?? AbortSignal.timeout(30000)]) });
    };
    const result = await signedCall(writeFetch, { token: async () => token }, "Google Docs",
      `https://docs.googleapis.com/v1/documents/${value.documentId}:batchUpdate`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests: [request], writeControl: { requiredRevisionId: value.revisionId } }) });
    return { documentId: value.documentId, tabId: value.tabId, operation: action, providerAcknowledgement: result,
      note: "Google acknowledged the revision-guarded batch. No separate read-back verification was performed." };
  }
}
export function registerDocsWrites(registry: Pick<ToolRegistry, "register">, docs: DocsWrite) {
  registry.register({ name: "gdocs.inspect", permission: "personal.read", parameters: DocsInspect,
    description: "Read Google document title, tab IDs and current revision for a bounded write preview.", execute: input => docs.inspect(input) });
  registry.register({ name: "gdocs.append", permission: "personal.write", parameters: DocsAppend,
    description: "Append plain text to one Google Docs tab, at an inspected revision, after owner one-time confirmation.",
    target: input => `Google Docs append exact text: ${JSON.stringify(input)}`, execute: (input, context) => docs.write("append", input, context.signal) });
  registry.register({ name: "gdocs.replace_text", permission: "personal.write", parameters: DocsReplace,
    description: "Replace every literal case-sensitive occurrence within one inspected tab/revision after confirmation. Empty replacement deletes matches.",
    target: input => `Google Docs replace all matching literal text in one tab: ${JSON.stringify(input)}`, execute: (input, context) => docs.write("replace", input, context.signal) });
}
