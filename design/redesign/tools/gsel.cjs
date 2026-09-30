// The window's own dropdown (public/app/core/gsel.js) for the verify tools, driven the way a person does: press it, then
// press a choice in its glass list. It replaced the system's <select> (#650), so selectOption, `option` and
// selectedOptions no longer apply. Same shape as tests/gsel.mjs.

/** The choices a dropdown offers: [{ value, words, off }]. */
const gselChoices = (locator) => locator.evaluate((el) => JSON.parse(el.dataset.opts ?? "[]").map(([value, words, off]) => ({ value, words, off: !!off })));

/** What it shows now: its value, its words, and whether it is greyed. */
const gselShown = (locator) => locator.evaluate((el) => ({ value: el.value, text: el.querySelector(".gsel-t")?.textContent ?? "",
  disabled: el.disabled || el.getAttribute("aria-disabled") === "true" }));

/** Picks `value` through the list; resolves once the list has closed. Throws when there is no such choice. */
async function pickGsel(locator, value, { timeout = 10000 } = {}) {
  await locator.waitFor({ timeout });
  const choices = await gselChoices(locator);
  const at = choices.findIndex((choice) => choice.value === value);
  if (at < 0) throw new Error(`no choice "${value}" (${choices.map((c) => c.value).join(", ")})`);
  await locator.click({ timeout });
  const page = locator.page();
  const item = page.locator(`.gsel-pop [data-act="gsel-pick"][data-i="${at}"]`);
  await item.scrollIntoViewIfNeeded({ timeout });
  await item.click({ timeout });
  await page.locator(".gsel-pop").waitFor({ state: "detached", timeout });
}

module.exports = { gselChoices, gselShown, pickGsel };
