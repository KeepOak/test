import { z } from "zod";
import { hiddenSkillCharacters, upstreamSkillPatterns } from "./skill-scan-patterns.js";

/**
 * Scans a skill document before it can be activated. It looks for hardcoded secrets, instructions
 * to send data somewhere, and attempts to override the assistant's rules. The owner's policy
 * decides whether a finding blocks the skill or holds it for review.
 */
export const SkillScanPolicySchema = z.object({ policy: z.enum(["block", "review"]).default("block") }).strict();
export type SkillScanPolicy = z.infer<typeof SkillScanPolicySchema>["policy"];
export interface SkillFinding { kind: "secret" | "exfiltration" | "override" | "persistence" | "destructive" | "obfuscation" | "network"; line: number; excerpt: string; reason: string }

/** Shared with the conversation share export, which blanks these out before anything leaves the app. */
export const secretPatterns: [RegExp, string][] = [
  [/\bAKIA[0-9A-Z]{16}\b/, "looks like an AWS access key"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/, "looks like an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "looks like a GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "looks like a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "contains a private key"],
  [/\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9_\-/+.]{16,}/i, "assigns a value to a secret-like name"],
];
const exfiltrationPatterns: [RegExp, string][] = [
  [/\b(?:curl|wget|fetch|http\.post|requests\.post|Invoke-WebRequest)\b[^\n]*\bhttps?:\/\//i, "sends data to an outside address"],
  [/\b(?:send|upload|post|forward|transmit|email)\b[^\n]{0,80}\b(?:secrets?|tokens?|api keys?|passwords?|credentials?|memory|memories|conversation|history|\.env|environment variables?)\b[^\n]{0,80}\b(?:to|at)\b[^\n]{0,40}(?:https?:\/\/|@|webhook|server|address)/i, "asks to send private data somewhere"],
  [/\b(?:secrets?|tokens?|api keys?|passwords?|credentials?)\b[^\n]{0,60}\b(?:to|into)\b[^\n]{0,40}\bhttps?:\/\//i, "points secrets at an outside address"],
];
const overridePatterns: [RegExp, string][] = [
  [/\bignore (?:all |any )?(?:previous|prior|earlier|above|the) (?:instructions|rules|guidance)/i, "tells the assistant to ignore its rules"],
  [/\bdo not (?:tell|inform|show|mention (?:this )?to) (?:the )?(?:user|owner|person)\b/i, "asks the assistant to hide something from you"],
  [/\b(?:hide|conceal) (?:this|these|that) from (?:the )?(?:user|owner)\b/i, "asks the assistant to hide something from you"],
  [/\b(?:you are now|from now on you are|act as if you have) (?:no|without) (?:restrictions|limits|rules)\b/i, "tries to remove the assistant's limits"],
  [/\bsystem prompt\b[^\n]{0,40}\b(?:reveal|print|output|leak|ignore|override)\b/i, "targets the assistant's system instructions"],
];

export function scanSkill(document: string): SkillFinding[] {
  const findings: SkillFinding[] = [];
  const lines = document.split(/\r?\n/);
  const groups: [SkillFinding["kind"], [RegExp, string][]][] = [["secret", secretPatterns], ["exfiltration", exfiltrationPatterns], ["override", overridePatterns], ...upstreamSkillPatterns];
  const invisible = new RegExp(hiddenSkillCharacters.source, "g");
  for (const [index, text] of lines.entries()) {
    const visible = text.replace(invisible, "");
    for (const [kind, patterns] of groups) {
      const hit = patterns.find(([pattern]) => pattern.test(text) || pattern.test(visible));
      if (!hit) continue;
      findings.push({ kind, line: index + 1, excerpt: text.trim().slice(0, 120), reason: hit[1] });
      if (findings.length >= 20) return findings;
    }
  }
  return findings;
}

/** One sentence per finding, for an error or a review list. */
export function describeFindings(findings: SkillFinding[]): string {
  return findings.map((f) => `line ${f.line} ${f.reason}`).join("; ");
}
