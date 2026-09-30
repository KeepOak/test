import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Store } from './store.js';
import type { ToolContext } from './contracts.js';
import type { SkillPackages } from './skill-packages.js';
import { ToolRegistry } from './registry.js';
import { registerHttpTools, type HttpToolHost } from './skill-http-tools.js';
import { HttpToolSchema, packSkill, type HttpTool } from './skill-package.js';
import type { CapturedRequestShape } from './browser-network-capture.js';
import { InputsSchema } from './recipes.js';
import { evaluatePolicy, readPolicy } from './policy.js';
import { grantAll } from './manifest-permissions.js';
import { tightenCheck } from './safety-extras/hooks.js';

const secretHeader = z.object({ name: z.enum(['Authorization', 'X-Api-Key']), secret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), bearer: z.boolean().default(false) }).strict();
export const CapturedSkillOptionsSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(50), description: z.string().min(1).max(300),
  pick: HttpToolSchema.shape.pick.removeDefault().min(1), credential: secretHeader.optional(),
}).strict();
export const CapturedSkillTestSchema = z.object({
  arguments: InputsSchema, expected: z.record(z.string().max(120), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])),
  confirm: z.boolean().default(false), confirmMutation: z.string().optional(),
}).strict();
type Options = z.infer<typeof CapturedSkillOptionsSchema>;
interface Draft { id: string; name: string; tool: HttpTool; revision: string; proof: { revision: string; suite: string; at: string } | null }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (id: string): string => `captured-api-skill:${id}`;

function toolFrom(shape: CapturedRequestShape, options: Options): HttpTool {
  if (shape.unsupported) throw new Error(shape.unsupported);
  if (shape.needsCredentials && !options.credential) throw new Error('This request used browser credentials. Choose a saved API credential; browser cookies are never copied.');
  const input: HttpTool['input'] = {}, body: Record<string, string> = {};
  const query = shape.query.map(name => { input[`q_${name}`] = { type: 'string', required: true }; return `${encodeURIComponent(name)}={{q_${name}}}`; });
  for (const name of shape.body) { input[`b_${name}`] = { type: 'string', required: true }; body[name] = `{{b_${name}}}`; }
  const credential = options.credential;
  const headers = credential ? { [credential.name]: `${credential.bearer ? 'Bearer ' : ''}{{secret:${credential.secret}}}` } : {};
  return HttpToolSchema.parse({ name: 'call', description: options.description, method: shape.method,
    url: `${shape.origin}${shape.path}${query.length ? `?${query.join('&')}` : ''}`, input, body, headers, pick: options.pick });
}

/** Candidate tests use the installed skill HTTP executor, with a separate registry and no global activation. */
export class CapturedApiSkills {
  private readonly testing = new Set<string>();
  constructor(private readonly store: Store, private readonly owner: string, private readonly host: HttpToolHost,
    private readonly packages: SkillPackages) {}
  create(shape: CapturedRequestShape, input: unknown): Draft {
    const options = CapturedSkillOptionsSchema.parse(input), tool = toolFrom(shape, options);
    const draft: Draft = { id: randomUUID(), name: options.name, tool, revision: hash([options.name, tool]), proof: null };
    this.save(draft); return draft;
  }
  view(id: string): Draft {
    const found = this.store.get('settings', this.owner, key(id));
    if (!found) throw new Error('API skill draft not found.');
    return structuredClone(found.data) as unknown as Draft;
  }
  private save(draft: Draft): void { this.store.save('settings', this.owner, key(draft.id), { ...draft }); }
  /** Only response selection and wording are editable; changing inputs starts a fresh request-shaped draft. */
  edit(id: string, input: unknown): Draft {
    const draft = this.view(id), options = CapturedSkillOptionsSchema.omit({ credential: true }).parse(input);
    draft.name = options.name; draft.tool.description = options.description; draft.tool.pick = options.pick;
    draft.revision = hash([draft.name, draft.tool]); draft.proof = null; this.save(draft); return draft;
  }
  mutationPhrase(id: string, args: Record<string, unknown>): string {
    const draft = this.view(id); return `${draft.tool.method} ${draft.tool.url} ${draft.revision} ${JSON.stringify(args)}`;
  }
  async test(id: string, input: unknown, context: ToolContext, authorize: () => void) {
    if (this.testing.has(id)) throw new Error('This draft is already being tested.');
    this.testing.add(id);
    try { return await this.evaluate(id, input, context, authorize); }
    finally { this.testing.delete(id); }
  }
  private async evaluate(id: string, input: unknown, context: ToolContext, authorize: () => void) {
    const draft = this.view(id), test = CapturedSkillTestSchema.parse(input), toolName = `skill.${draft.name}.call`;
    authorize();
    const target = new URL(draft.tool.url.replace(/\{\{[a-z0-9_]+\}\}/g, 'x'));
    const policy = readPolicy(this.store, this.owner);
    const decision = evaluatePolicy(policy, { tool: toolName, target: target.host, readOnly: false,
      resource: { kind: 'host', value: target.hostname } }).decision;
    const safety = tightenCheck(this.store, this.owner, { tool: toolName, permission: 'skills.http', resource: { kind: 'host', value: target.hostname }, source: 'owner' }, decision);
    if (safety.decision === 'deny' || safety.code || (safety.decision === 'ask' && !test.confirm)) throw new Error('Your skill HTTP policy requires approval or refuses this call.');
    if (draft.tool.method === 'POST' && test.confirmMutation !== this.mutationPhrase(id, test.arguments)) throw new Error('Confirm this exact POST draft and inputs before testing its side effect.');
    if (!Object.keys(test.expected).length || Object.keys(test.expected).some(path => !draft.tool.pick.includes(path)))
      throw new Error('Choose at least one expected value from the selected response paths.');
    draft.proof = null; this.save(draft);
    const registry = new ToolRegistry(), grant = grantAll({ permissions: [{ permission: 'skills.http', why: 'Test this captured API skill' }], hosts: [target.hostname] });
    const host: HttpToolHost = { ...this.host, fetchImpl: async (address, init) => {
      authorize(); context.signal.throwIfAborted();
      if (hash(readPolicy(this.store, this.owner)) !== hash(policy)) throw new Error('Permissions changed; review this test again.');
      const currentSafety = tightenCheck(this.store, this.owner,
        { tool: toolName, permission: 'skills.http', resource: { kind: 'host', value: target.hostname }, source: 'owner' }, decision);
      if (currentSafety.decision === 'deny' || currentSafety.code) throw new Error('Safety settings changed; review this test again.');
      return (this.host.fetchImpl ?? this.host.policy.guard(globalThis.fetch))(address, { ...init,
        signal: AbortSignal.any([context.signal, ...(init?.signal ? [init.signal] : [])]) });
    } };
    registerHttpTools(registry, host, draft.name, [draft.tool], () => { authorize(); return true; }, grant);
    const result = await registry.execute(toolName, test.arguments, context) as { data: Record<string, unknown> };
    authorize();
    const passed = Object.entries(test.expected).every(([path, expected]) => isDeepStrictEqual(result.data[path], expected));
    const current = this.view(id);
    if (current.revision !== draft.revision) throw new Error('The draft changed while it was being tested. Test it again.');
    current.proof = passed ? { revision: draft.revision, suite: hash([test.arguments, test.expected]), at: new Date().toISOString() } : null;
    this.save(current); return { passed, revision: draft.revision, proof: current.proof };
  }
  install(id: string, revision: string) {
    const draft = this.view(id);
    if (draft.revision !== revision || draft.proof?.revision !== revision) throw new Error('Test this exact draft successfully before installing it.');
    const document = `---\nname: ${draft.name}\ndescription: ${JSON.stringify(draft.tool.description)}\n---\n\nUse skill.${draft.name}.call with explicit inputs to call the selected API. Follow the current task and permission rules.\n`;
    const bytes = packSkill({ author: 'Owner', packageVersion: '1.0.0', files: { 'SKILL.md': document, 'tools.json': JSON.stringify({ tools: [draft.tool] }) } });
    return this.packages.install(bytes, true);
  }
}
