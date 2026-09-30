import type { Runtime } from "../runtime.js";
import type { FacebookPages } from "./facebook-pages.js";

export async function facebookApi(pages: FacebookPages, runtime: Runtime, path: string, method: string,
  readBody: () => Promise<unknown>, requireWindow: () => void) {
  requireWindow();
  if (method === "GET" && path === "/api/personal/facebook") return pages.overview();
  if (method !== "POST") throw new Error("Use GET or POST for Facebook Pages");
  const input = await readBody(); requireWindow();
  if (path === "/api/personal/facebook") return pages.configure(input);
  if (path === "/api/personal/facebook/revoke") { pages.clear(); return { revoked: true }; }
  if (path === "/api/personal/facebook/review") return pages.review(input);
  const tools: Record<string, string> = { "/api/personal/facebook/posts": "social.facebook.posts", "/api/personal/facebook/compose": "social.facebook.compose", "/api/personal/facebook/publish": "social.facebook.publish" };
  if (!tools[path]) throw new Error("Unsupported Facebook Page operation");
  const result = await runtime.executeTool(tools[path]!, input, { mode: "owner", source: "owner" });
  requireWindow(); return result;
}
