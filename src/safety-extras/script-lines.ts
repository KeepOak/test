import { StringDecoder } from "node:string_decoder";

/** Unlike readline, never buffers an unbounded line from untrusted generated code. */
export class ScriptLines {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private stopped = false;
  constructor(private readonly line: (text: string) => void, private readonly overflow: () => void) {}
  push(chunk: Buffer): void {
    if (this.stopped) return;
    const parts = this.decoder.write(chunk).split("\n");
    for (let index = 0; index < parts.length; index++) {
      this.pending += parts[index];
      if (Buffer.byteLength(this.pending) > 64_000) {
        this.stopped = true; this.pending = ""; this.overflow(); return;
      }
      if (index < parts.length - 1) { this.line(this.pending.replace(/\r$/, "")); this.pending = ""; }
    }
  }
}
