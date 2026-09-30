import type { PolicyRule } from "../policy.js";

/** Only an explicit global rule for this one tool opts into routine settings changes.
 * A category, preset, wildcard, scoped rule or unmatched allow does not opt in. */
export function ordinarySettingsRule(rule: PolicyRule | null | undefined): boolean {
  return !!rule && rule.tool === "settings.change" && rule.match === "*" && rule.decision === "allow"
    && rule.applies !== "reads" && rule.trunk === undefined && rule.resource === undefined;
}
