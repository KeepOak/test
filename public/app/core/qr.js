/* A square code drawn from the engine's own matrix ({size, rows: ["0101…"]}), the way the prototype draws one: white
   tile, a two-module quiet zone, dark modules as one path. */

import { t } from "../../i18n.js";

export function qr(code, size = 148) {
  if (!code?.rows?.length) return "";
  const n = code.rows.length;
  const c = size / (n + 4);
  let d = "";
  code.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "1") d += `M${((x + 2) * c).toFixed(2)} ${((y + 2) * c).toFixed(2)}h${c.toFixed(2)}v${c.toFixed(2)}h-${c.toFixed(2)}z`;
  });
  return `<span class="qrbox12"><svg class="qr12" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${t("window.core.qr.qr-code")}"><rect width="100%" height="100%" rx="10" fill="#fff"/><path d="${d}" fill="#111"/></svg></span>`;
}
