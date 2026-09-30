/* Matrix image content fields follow OpenClaw extensions/matrix/src/matrix/send/media.ts (OpenClaw Foundation, MIT). */
import type { OutgoingFile } from "./router.js";

/** Inline Matrix image content: caption stays on the image when it is replaced. */
export function matrixPictureContent(file: OutgoingFile, url: string): Record<string, unknown> {
  return { msgtype: "m.image", body: (file.caption || file.name).slice(0, 3500), filename: file.name, url,
    info: { size: file.bytes.byteLength, mimetype: file.mediaType } };
}
