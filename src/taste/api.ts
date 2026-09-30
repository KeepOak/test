import { z } from "zod";
import type { TasteLearning } from "./learning.js";

export const tasteApiPaths = ["/api/taste/feedback", "/api/taste/preferences", "/api/taste/correct", "/api/taste/forget"] as const;
export const handlesTasteApiPath = (path: string): boolean => tasteApiPaths.some(item => item === path);
const Session = z.object({ sessionId: z.string().uuid() }).strict();
const Edit = Session.extend({ id: z.string().uuid(), revision: z.number().int().positive() });
/** The server supplies a live full-owner-window authorizer; callers cannot assert ownership in JSON. */
export class TasteApi {
  constructor(private readonly learning: TasteLearning) {}
  async handle(owner: string, method: string, path: string, input: unknown, authorize: () => void): Promise<unknown> {
    authorize();
    if (path === "/api/taste/preferences" && method === "GET") {
      const { sessionId } = Session.parse(input);
      return { preferences: this.learning.list(owner, sessionId) };
    }
    if (method !== "POST") throw new Error("Unsupported preference operation.");
    if (path === "/api/taste/feedback") {
      const receipt = await this.learning.feedback(owner, input, authorize); authorize(); return { receipt };
    }
    if (path === "/api/taste/correct") {
      const value = Edit.extend({ text: z.string().trim().min(1).max(400) }).parse(input);
      return { preference: this.learning.correct(owner, value.sessionId, value.id, value.revision, value.text) };
    }
    if (path === "/api/taste/forget") {
      const value = Edit.parse(input);
      return this.learning.forget(owner, value.sessionId, value.id, value.revision);
    }
    throw new Error("Preference route not found.");
  }
}
