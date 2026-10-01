import { cleanWords, mostWords } from "./voice-dictation.js";

/** Interpret whisper.cpp's MIT stream.cpp terminal rewrite protocol (6e4ab854f67f).
 * Original Branch parser: each clear-line replaces the provisional window; newline commits it.
 * ANSI escapes may straddle stdout chunks. Only the current bounded line is retained. */
export class StreamWords {
  private line = "";
  private escape = "";
  private last = "";
  constructor(private readonly emit: (words: string, final: boolean) => void) {}

  write(piece: string): void {
    for (const char of piece) {
      if (this.escape || char === "\x1b") { this.control(char); continue; }
      if (char === "\r") { this.line = ""; continue; }
      if (char === "\n") { this.publish(true); this.line = ""; this.last = ""; continue; }
      this.line = (this.line + char).slice(-mostWords);
    }
    this.publish(false);
  }
  finish(): void { this.publish(true); this.line = ""; this.last = ""; this.escape = ""; }

  private control(char: string): void {
    this.escape += char;
    if (this.escape === "\x1b" || this.escape === "\x1b[") return;
    if (/^\x1b\[[0-9;?]*[A-Za-z]$/.test(this.escape)) {
      if (this.escape.endsWith("K")) this.line = "";
      this.escape = "";
    } else if (this.escape.length > 32 || !/^\x1b\[[0-9;?]*$/.test(this.escape)) this.escape = "";
  }
  private publish(final: boolean): void {
    const words = cleanWords(this.line);
    if (!words || (!final && words === this.last)) return;
    this.last = words;
    this.emit(words, final);
  }
}
