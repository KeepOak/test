/** Branch versions in order: numbers first, then a prerelease sorts below its release (0.19.3-dev.1 < 0.19.3). */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new Error(`Invalid Branch version: ${value}`);
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
      pre: match[4]?.split(".") ?? [] };
  };
  const left = parse(a), right = parse(b);
  for (let index = 0; index < 3; index++) {
    const difference = left.numbers[index]! - right.numbers[index]!;
    if (difference) return Math.sign(difference);
  }
  if (!left.pre.length || !right.pre.length) return Number(right.pre.length > 0) - Number(left.pre.length > 0);
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const one = left.pre[index], two = right.pre[index];
    if (one === undefined || two === undefined) return one === undefined ? -1 : 1;
    if (one === two) continue;
    const numericOne = /^\d+$/.test(one), numericTwo = /^\d+$/.test(two);
    if (numericOne && numericTwo) return Math.sign(Number(one) - Number(two));
    if (numericOne !== numericTwo) return numericOne ? -1 : 1;
    return one < two ? -1 : 1;
  }
  return 0;
}
