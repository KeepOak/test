import { z } from "zod";

/** A request receipt is distinct from evidence that an update finished. */
export const desktopUpdateReceiptSchema = z.object({
  accepted: z.boolean(), words: z.string(),
  updater: z.object({ phase: z.string(), message: z.string() }).strict(),
}).strict();
export type DesktopUpdateReceipt = z.infer<typeof desktopUpdateReceiptSchema>;
