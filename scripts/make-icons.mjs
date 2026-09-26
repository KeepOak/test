/**
 * Branch's icon is its mascot. Every icon and favicon is made from one picture, docs/images/mascot.png,
 * with the repository's own PNG code (apps/mobile/scripts/png.mjs), so nothing has to be installed.
 *
 *   node scripts/make-icons.mjs
 *
 * writes the two masters the build-time icon code reads (public/assets/branch-mascot.png, the whole
 * mascot at 1024, and branch-face.png, its face at 256 for the smallest sizes, where the branches
 * and orbs are too thin to see), the window's favicons and install icons, and public/assets/branch.ico.
 * The desktop packager (scripts/package-desktop.mjs) and the phone icons (apps/mobile/scripts/icons.mjs)
 * make their own sizes from the masters.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compose, readPng, scale, trim, writePng } from "../apps/mobile/scripts/png.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(repo, "public", "assets");
export const SOURCE = join(repo, "docs", "images", "mascot.png");
export const MASCOT = join(assets, "branch-mascot.png");
export const FACE = join(assets, "branch-face.png");
export const WINDOWS_ICON = join(assets, "branch.ico");

/** The face, as a square of the 1254px source: the round body and eyes, the branches cut off. */
const FACE_BOX = { x: 385, y: 440, side: 600 };
/** At this size and below the face is drawn instead of the whole mascot. */
export const FACE_UP_TO = 32;
/** The sizes inside branch.ico: Windows picks one for each list, taskbar and shortcut. */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function crop(image, { x, y, side }) {
  const data = Buffer.alloc(side * side * 4);
  for (let row = 0; row < side; row++)
    for (let col = 0; col < side; col++) {
      const sy = y + row, sx = x + col;
      if (sy < 0 || sx < 0 || sy >= image.height || sx >= image.width) continue;
      const from = (sy * image.width + sx) * 4;
      image.data.copy(data, (row * side + col) * 4, from, from + 4);
    }
  return { width: side, height: side, data };
}

/** The two masters from the one source picture. */
export async function mastersFromSource(source = SOURCE) {
  const art = readPng(await readFile(source));
  return { mascot: compose(trim(art), 1024, 0.96, null), face: scale(crop(art, FACE_BOX), 256) };
}

/** The masters as the build reads them, from public/assets. */
export async function readMasters() {
  return { mascot: readPng(await readFile(MASCOT)), face: readPng(await readFile(FACE)) };
}

/** The mascot at one size on a clear ground: its face when the size is too small for the rest. */
export function iconAt(masters, size) {
  return size <= FACE_UP_TO ? scale(masters.face, size) : scale(masters.mascot, size);
}

/** A Windows .ico holding one PNG per size (Vista and later read PNG entries). */
export function icoFile(images) {
  const pngs = images.map((image) => writePng(image));
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, index) => {
    const at = 6 + 16 * index, side = images[index].width;
    header[at] = side >= 256 ? 0 : side;
    header[at + 1] = side >= 256 ? 0 : side;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}

/** branch.ico, made from the masters; the Windows packager calls this before every build. */
export async function writeWindowsIcon(masters) {
  const from = masters ?? await readMasters();
  await writeFile(WINDOWS_ICON, icoFile(ICO_SIZES.map((size) => iconAt(from, size))));
  return WINDOWS_ICON;
}

/** The window's dark ground in the default theme, the same colour the phone icons sit on. */
export async function darkGround() {
  const catalogue = await import(pathToFileURL(join(repo, "public", "theme-catalogue.js")).href);
  const { NATIVE_THEME, nativePalettes } = await import(pathToFileURL(join(repo, "apps", "mobile", "web", "palette.js")).href);
  return nativePalettes(catalogue, NATIVE_THEME).dark.ground;
}

/** The favicons and install icons public/index.html, the manifest and the other pages name. */
export async function writeWebIcons(masters, ground) {
  const put = (name, image, opaque = false) => writeFile(join(assets, name), writePng(image, opaque));
  // The face on a clear ground: it read on light and dark browser tabs alike, where a dark tile vanished.
  await put("favicon-16.png", iconAt(masters, 16));
  await put("favicon-32.png", iconAt(masters, 32));
  await put("icon-192.png", iconAt(masters, 192));
  await put("icon-512.png", iconAt(masters, 512));
  // Full-bleed and opaque: the phone cuts its own shape, and keeps the middle 80% (the safe zone).
  await put("icon-maskable-512.png", compose(masters.mascot, 512, 0.62, ground), true);
  // iOS turns see-through pixels black and rounds the corners itself.
  await put("apple-touch-icon.png", compose(masters.mascot, 180, 0.8, ground), true);
}

export async function makeIcons() {
  const masters = await mastersFromSource();
  await writeFile(MASCOT, writePng(masters.mascot));
  await writeFile(FACE, writePng(masters.face));
  await writeWebIcons(masters, await darkGround());
  await writeWindowsIcon(masters);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await makeIcons();
  console.log("Icons written from docs/images/mascot.png.");
}
