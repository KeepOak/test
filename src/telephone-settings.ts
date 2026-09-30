import { z } from "zod";
export const TelephoneSettings = z.object({ enabled: z.boolean().default(false),
  accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/), authTokenSecret: z.string().min(1).max(100),
  from: z.string().regex(/^\+[1-9]\d{6,14}$/), ownNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
  publicOrigin: z.string().url().refine((v) => { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/"; }),
  pinSecret: z.string().min(1).max(100),
}).strict();
export const TelephoneProposal = z.object({ direction: z.enum(["outbound", "inbound"]), to: z.string().regex(/^\+[1-9]\d{6,14}$/),
  purpose: z.string().trim().min(1).max(600), maxSeconds: z.number().int().min(30).max(300),
  carrierBudgetUsd: z.number().positive().max(10), maxModelTokens: z.number().int().min(256).max(4000),
}).strict();
export type TelephoneConfig = z.infer<typeof TelephoneSettings>;
export type CallTerms = z.infer<typeof TelephoneProposal>;
