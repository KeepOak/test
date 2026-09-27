// The characters' smaller encodes (public/art/**/<name>.<width>.webm) against the loops they were made from: each pair
// drawn side by side at the size the window draws it, paused on the same frames, on the light and the dark background,
// at a device pixel ratio. Prints how far apart they are as drawn (per channel, premultiplied, 0-255: the mean over the
// picture and the largest single pixel) and saves the screenshots.
//   [OUT=<folder for the screenshots>] [DPRS=1,1.5,2] node design/redesign/tools/verify-small-clips.cjs
// Also checks every smaller encode has the same number of frames at the same rate as its loop, and keeps its alpha.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");

const ART = path.resolve(__dirname, "../../../public/art");
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), "small-clips-"));
const DPRS = (process.env.DPRS || "1,1.5,2").split(",").map(Number);
const TIMES = [0.4, 1.9, 3.7];
const BG = { light: "#FBFAF7", dark: "#16181A" };

/* Every smaller encode beside the loop it was made from. */
function variants() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, e.name);
      if (e.isDirectory()) walk(at);
      const m = /^(.+)\.(\d+)\.webm$/.exec(e.name);
      if (m) out.push({ file: at, from: path.join(dir, `${m[1]}.webm`), width: Number(m[2]) });
    }
  };
  walk(ART);
  return out;
}

const probe = (file) => execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames,r_frame_rate:stream_tags=alpha_mode", "-of", "csv=p=0", file], { encoding: "utf8" }).trim().toLowerCase();

/* The sizes the window draws them at (CSS px), each with the smaller encode it picks there (core/art17.js sized). */
function cases(all, dpr) {
  const pick = (from, px) => {
    const need = Math.ceil(px * dpr), w = [96, 160, 300].find((x) => x >= need);
    return w && all.find((v) => v.from === from && v.width === w);
  };
  const out = [];
  const faces = [["agents/bolt/idle.webm", 47], ["agents/ember/work.webm", 47], ["agents/nib/yay.webm", 66], ["agents/kite/think.webm", 72], ["agents/tock/talk.webm", 110], ["anim-talk.webm", 33], ["anim-idle.webm", 150]];
  for (const [file, px] of faces) {
    const v = pick(path.join(ART, file), px);
    if (v) out.push({ ...v, px });
  }
  return out;
}

async function compare(browser, pair, dpr, theme) {
  const page = await browser.newPage({ deviceScaleFactor: dpr, viewport: { width: 760, height: Math.ceil(pair.px + 40) } });
  const url = (f) => "file:///" + f.split(path.sep).join("/");
  const html = `<body style="margin:0;background:${BG[theme]};display:flex;gap:24px;padding:12px">` + TIMES.map((t, i) =>
    `<div style="display:flex;gap:6px"><video id="a${i}" muted preload="auto" src="${url(pair.from)}" style="width:${pair.px}px;height:${pair.px}px"></video><video id="b${i}" muted preload="auto" src="${url(pair.file)}" style="width:${pair.px}px;height:${pair.px}px"></video></div>`).join("") + "</body>";
  const at = path.join(OUT, "page.html");
  fs.writeFileSync(at, html);
  await page.goto(url(at));
  const diff = await page.evaluate(async ([times, px, dpr]) => {
    const seek = (v, t) => new Promise((resolve, reject) => {
      const go = () => { v.addEventListener("seeked", resolve, { once: true }); v.currentTime = t; };
      v.addEventListener("error", () => reject(new Error(v.src + " did not load")), { once: true });
      if (v.readyState >= 1) go(); else v.addEventListener("loadedmetadata", go, { once: true });
    });
    const n = Math.round(px * dpr);
    const grab = (v) => { const c = new OffscreenCanvas(n, n), x = c.getContext("2d"); x.drawImage(v, 0, 0, n, n); return x.getImageData(0, 0, n, n).data; };
    let sum = 0, max = 0, count = 0;
    for (let i = 0; i < times.length; i++) {
      const a = document.getElementById("a" + i), b = document.getElementById("b" + i);
      await Promise.all([seek(a, times[i]), seek(b, times[i])]);
      const p = grab(a), q = grab(b);
      for (let k = 0; k < p.length; k += 4) {
        for (let c = 0; c < 3; c++) { const d = Math.abs(p[k + c] * p[k + 3] - q[k + c] * q[k + 3]) / 255; sum += d; max = Math.max(max, d); }
        const d = Math.abs(p[k + 3] - q[k + 3]);
        sum += d; max = Math.max(max, d); count += 4;
      }
    }
    return { mean: Math.round((sum / count) * 100) / 100, max: Math.round(max) };
  }, [TIMES, pair.px, dpr]);
  const name = `${path.relative(ART, pair.file).split(path.sep).join("_").replace(/\.webm$/, "")}-at${pair.px}px-dpr${dpr}-${theme}.png`;
  await page.screenshot({ path: path.join(OUT, name) });
  await page.close();
  return { ...diff, shot: name };
}

(async () => {
  const all = variants();
  const wrong = all.filter((v) => !fs.existsSync(v.from) || probe(v.file) !== probe(v.from));
  console.log(`${all.length} smaller encodes; frames, rate and alpha differ from their loop in ${wrong.length}${wrong.length ? ": " + wrong.map((v) => v.file).join(", ") : ""}`);
  const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
  console.log("loop                         drawn  dpr  encode   mean / max (the same on either background: compared before drawing on one)");
  for (const dpr of DPRS) for (const pair of cases(all, dpr)) {
    const light = await compare(browser, pair, dpr, "light");
    await compare(browser, pair, dpr, "dark");
    console.log(`${path.relative(ART, pair.from).split(path.sep).join("/").padEnd(28)} ${String(pair.px).padStart(4)}px ${String(dpr).padStart(4)}  ${String(pair.width).padStart(4)}px   ${String(light.mean).padStart(5)} / ${String(light.max).padStart(3)}`);
  }
  await browser.close();
  console.log(`screenshots: ${OUT}`);
  if (wrong.length) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
