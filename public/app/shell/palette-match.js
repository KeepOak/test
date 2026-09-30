/* Cline context-mentions (Apache-2.0) informed ranked fuzzy results; this small
   subsequence scorer is original and adds no fzf dependency. */
const normalize = (value) => String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
function score(query, value) {
  const text = normalize(value), phrase = normalize(query).trim();
  if (!phrase) return 0;
  const letters = phrase.replace(/\s/g, "");
  if (letters.length > text.length) return -Infinity;
  let total = 0, previous = -1;
  for (const letter of letters) {
    const at = text.indexOf(letter, previous + 1);
    if (at < 0) return -Infinity;
    total += at === previous + 1 ? 8 : 2;
    if (at === 0 || /[\s_/-]/.test(text[at - 1])) total += 12;
    total -= Math.min(at - previous - 1, 10);
    previous = at;
  }
  if (text.includes(phrase)) total += 100;
  if (text.startsWith(phrase)) total += 50;
  return total - text.length / 100;
}
export function paletteScore(query, item) {
  if (!query.trim()) return 0;
  const ranked = Math.max(score(query, item.label) + 40, score(query, item.sub));
  return item.found ? Math.max(0, ranked) : ranked;
}
