/**
 * The lines of work the Dev update channel may follow: the repository's own branches, named here and nowhere else.
 * The owner picks one in Settings › Updates (the comfort card "notify", field devLine). It becomes a git argument
 * (`ls-remote`, `clone --branch`), so it is never a ref, address or repository anyone typed: only these exact names.
 */
export const devLines = ["mac/cross-platform", "redesign/window"] as const;
export type DevLine = (typeof devLines)[number];
/** Branch's main line, and the one a Dev install follows until the owner picks another. */
export const defaultDevLine: DevLine = "mac/cross-platform";

export function isDevLine(value: unknown): value is DevLine {
  return typeof value === "string" && (devLines as readonly string[]).includes(value);
}

/** The line named, checked against the list; anything else is refused before it reaches git. */
export function checkedDevLine(value: unknown): DevLine {
  if (!isDevLine(value)) throw new Error("That is not one of Branch's lines of work, so nothing was looked up or built.");
  return value;
}
