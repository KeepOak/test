/* A picture picker anybody can reuse (Your profile uses it; a Trunk's photo can too): a styled button over a hidden
   file input, and the picked file made small and square here before it goes to the engine, which checks its bytes, its
   type and its size itself. The caller marks "sw:<id>" live and reads the file in its own change listener:
     pickButton(id, label) draws the button; picked(file) answers a data address (PNG or JPEG) or throws. */
import { esc } from "../core/dom.js";
import { ic } from "../core/ui.js";
import { t } from "../../i18n.js";

export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export const pickButton = (id, label) =>
  `<label class="btn sm pick-yp" for="${esc(id)}">${ic("image", "s")}<span>${label}</span><input class="vh-yp" type="file" id="${esc(id)}" data-sw="${esc(id)}" accept="${PICTURE_TYPES.join(",")}"></label>`;

/* The middle square of the picture, `size` pixels a side: PNG for pictures that may be see-through, JPEG for the rest. */
export async function picked(file, size = 256) {
  if (!file || !PICTURE_TYPES.includes(file.type)) throw new Error(t("window.profile.picture-types"));
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(size, side);
    canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    return file.type === "image/jpeg" ? canvas.toDataURL("image/jpeg", 0.88) : canvas.toDataURL("image/png");
  } finally { bitmap.close(); }
}
