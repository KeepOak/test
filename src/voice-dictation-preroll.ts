/** Pipecat's BSD-2-Clause pre-speech buffering approach, base_smart_turn.py
 * at 20999cd7b816. Modified for Branch's continuous recognizer: older quiet frames
 * are forwarded, not discarded. Speech releases the 500ms look-behind buffer once,
 * then every frame (including quiet frames) is handed through immediately. */
export class DictationPreroll {
  private readonly pending: Uint8Array[] = [];
  private started = false;
  static readonly frames = 25;

  push(frame: Uint8Array, speech: boolean): Uint8Array[] {
    if (this.started) return [frame];
    this.pending.push(Uint8Array.from(frame));
    if (speech) { this.started = true; return this.flush(); }
    return this.pending.length > DictationPreroll.frames ? [this.pending.shift()!] : [];
  }
  flush(): Uint8Array[] { return this.pending.splice(0); }
  forget(): void { this.pending.length = 0; this.started = false; }
}
