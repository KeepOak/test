/*
 * Media content fields adapted from OpenClaw extensions/matrix/src/matrix/send/media.ts.
 * MIT License
 * 
 * Copyright (c) 2026 OpenClaw Foundation
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * 
 * Third-party notices for incorporated or adapted code are recorded in
 * THIRD_PARTY_NOTICES.md.
 * 
 */
import type { OutgoingFile } from "./router.js";

/** Inline Matrix image content: caption stays on the image when it is replaced. */
export function matrixPictureContent(file: OutgoingFile, url: string): Record<string, unknown> {
  return { msgtype: "m.image", body: (file.caption || file.name).slice(0, 3500), filename: file.name, url,
    info: { size: file.bytes.byteLength, mimetype: file.mediaType } };
}
