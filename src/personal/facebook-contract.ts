import { z } from "zod";
export const PageId = z.string().regex(/^[0-9]{1,30}$/);
export const PagePostId = z.string().regex(/^[0-9]{1,30}_[0-9]{1,30}$/);
export const FacebookSettings = z.object({ readEnabled: z.boolean().default(false), publishEnabled: z.boolean().default(false),
  pageId: PageId.optional(), tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  tokenProject: z.string().min(1).max(100).optional(), termsAndRightsAcknowledged: z.boolean().default(false),
  maxCallsPerDay: z.number().int().min(1).max(100).default(10) }).strict();
export type FacebookConfig = z.infer<typeof FacebookSettings>;
export const ComposeInput = z.object({ message: z.string().min(1).max(4000) }).strict();
export const PostsInput = z.object({ limit: z.number().int().min(1).max(20).default(10), days: z.number().int().min(1).max(30).default(7) }).strict();
export const PageIdentity = z.object({ id: PageId, name: z.string().max(200).optional() });
export const Post = z.object({ id: PagePostId, message: z.string().max(64000).optional(),
  created_time: z.string().max(80).optional(), permalink_url: z.string().url().max(1500).optional() });
export const Posts = z.object({ data: z.array(Post).max(20), paging: z.object({ next: z.string().max(8000).optional() }).optional() });
export const graphBase = "https://graph.facebook.com/v26.0";
