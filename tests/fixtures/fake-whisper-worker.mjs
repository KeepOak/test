// A stand-in for the faster-whisper worker (src/voice-whisper.ts): the same JSON-lines protocol, no Python, no model.
// It answers "heard <bytes> bytes", and a recording that is the word CRASH ends it the way a missing package would.
import { createInterface } from "node:readline";

if (process.env.FAKE_WHISPER_NO_START) { process.stderr.write("ModuleNotFoundError: No module named 'faster_whisper'\n"); process.exit(1); }
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const ask = JSON.parse(line);
  const sound = Buffer.from(ask.audio, "base64");
  if (sound.toString() === "CRASH") { process.stderr.write("RuntimeError: the model file is damaged\n"); process.exit(3); }
  if (sound.toString() === "SLOW") await new Promise((done) => setTimeout(done, 400));
  if (sound.toString() === "BAD") { process.stdout.write(JSON.stringify({ id: ask.id, error: "Invalid data found when processing input" }) + "\n"); continue; }
  process.stdout.write(JSON.stringify({ id: ask.id, text: ` heard ${sound.length} bytes${ask.partial ? " (partial)" : ""} `, language: ask.language ?? "en" }) + "\n");
}
