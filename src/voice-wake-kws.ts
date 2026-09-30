import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { VoiceSettings } from "./voice.js";
import type { ProgramPresent, WakeSpotter, WakeWordSettings } from "./voice-wake.js";

/** External Apache-2.0 sherpa-onnx microphone KWS CLI, 040afe360a38.
 * Hermes' MIT sherpa adapter (a9a54245b231) informed threshold/phrase mapping.
 * Owners supply their own licensed model and tokenized open-vocabulary keyword file.
 * No model is shipped or fetched, including openWakeWord's noncommercial pretrained models. */
export function keywordSpotter(voice: VoiceSettings, wake: WakeWordSettings, present: ProgramPresent): WakeSpotter | null {
  const file = "sherpa-onnx-keyword-spotter-microphone";
  const model = wake.keywordModel || voice.localSpeechModel;
  if (!model || !present(file)) return null;
  try {
    const keywords = wake.keywordFile || join(model, "keywords.txt");
    const display = wake.word.toUpperCase().replace(/\s+/g, "_");
    if (statSync(keywords).size > 64_000) return null;
    const entries = readFileSync(keywords, "utf8");
    if (entries.length > 64_000 || !entries.split(/\r?\n/).some((line) => line.trim().endsWith(`@${display}`))) return null;
    const models = ["encoder", "decoder", "joiner"].map((part) => modelPart(model, part));
    if (!models.every(Boolean) || !existsSync(join(model, "tokens.txt"))) return null;
    return { available: true, kind: "streaming-keyword", how:
      "Your installed sherpa-onnx keyword spotter stays loaded and listens continuously on this computer. It uses your model and tokenized keyword file, confirms trailing speech frames, and waits two seconds after a match. Nothing is downloaded or sent away. Switching off, locking Branch or Lockdown releases the microphone.",
      command: { file, args: [`--tokens=${join(model, "tokens.txt")}`, `--encoder=${models[0]}`,
        `--decoder=${models[1]}`, `--joiner=${models[2]}`, `--keywords-file=${keywords}`,
        `--keywords-threshold=${0.05 + 0.4 * wake.sureness / 100}`,
        `--num-trailing-blanks=${wake.confirmationFrames}`, "--num-threads=1", "--provider=cpu"], env: {} } };
  } catch { return null; }
}
function modelPart(model: string, part: string): string | null {
  const direct = join(model, `${part}.onnx`);
  if (existsSync(direct)) return direct;
  const found = readdirSync(model).sort().find((name) => name.startsWith(`${part}-`) && name.endsWith(".onnx"));
  return found ? join(model, found) : null;
}
