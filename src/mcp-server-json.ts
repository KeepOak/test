import { z } from 'zod';

// Bounded representation of the official pinned server.json input/package/remote fields.
// Protocol adaptation, independently implemented; no publisher code is executed.
const text = z.string().max(2000);
export const ServerInputSchema = z.object({
  description: text.optional(), format: z.enum(['string', 'number', 'boolean', 'filepath']).default('string'),
  isRequired: z.boolean().default(false), isSecret: z.boolean().default(false),
  choices: z.array(text).max(40).optional(), default: text.optional(), placeholder: text.optional(), value: text.optional(),
});
const WithVariables = ServerInputSchema.extend({ variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), ServerInputSchema).optional() });
const NamedInput = WithVariables.extend({ name: z.string().min(1).max(200) });
const Argument = WithVariables.extend({ type: z.enum(['named', 'positional']), name: text.optional(), valueHint: text.optional(), isRepeated: z.boolean().default(false) });
export const ServerPackageSchema = z.object({
  registryType: z.string().min(1).max(40), identifier: z.string().min(1).max(500),
  version: z.string().min(1).max(255).refine(v => v !== 'latest' && !/[\s*^~><|]/.test(v) && !/(?:^|\.)x(?:$|\.)/i.test(v), 'Use a specific package version').optional(),
  runtimeHint: z.string().max(100).optional(), registryBaseUrl: z.string().url().optional(), fileSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  transport: z.object({ type: z.enum(['stdio', 'streamable-http', 'sse']), url: text.optional() }),
  runtimeArguments: z.array(Argument).max(40).default([]), packageArguments: z.array(Argument).max(40).default([]),
  environmentVariables: z.array(NamedInput).max(20).default([]),
});
export const ServerRemoteSchema = z.object({
  type: z.enum(['streamable-http', 'sse']), url: z.string().min(1).max(2000),
  headers: z.array(NamedInput).max(20).default([]), variables: z.record(z.string(), ServerInputSchema).optional(),
});
export const ServerJsonSchema = z.object({
  $schema: z.string().url().optional(), name: z.string().regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/).max(200), title: z.string().max(100).optional(),
  description: z.string().max(500), version: z.string().min(1).max(255),
  packages: z.array(ServerPackageSchema).max(20).default([]), remotes: z.array(ServerRemoteSchema).max(20).default([]),
});

/** Publisher-supplied secret defaults are never returned to the window or retained in a catalogue. */
export function publicServerJson(input: unknown): z.infer<typeof ServerJsonSchema> {
  const server = ServerJsonSchema.parse(input);
  const scrub = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.isSecret === true) { delete node.value; delete node.default; delete node.placeholder; delete node.choices; }
    for (const child of Object.values(node)) scrub(child);
  };
  scrub(server); return server;
}
