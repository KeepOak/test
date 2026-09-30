/* The window's own dropdown (public/app/core/gsel.js), driven the way a person does: press it, then press a choice in
   its glass list. Shared by the tests that used to call selectOption on a native select. */

/** The choices a dropdown offers: [{ value, words, off }]. */
export const gselChoices = (locator) => locator.evaluate((el) => JSON.parse(el.dataset.opts ?? "[]").map(([value, words, off]) => ({ value, words, off: !!off })));

/** Picks `value` in the dropdown `locator`, through its list; resolves once the list has closed. */
export async function pickGsel(locator, value) {
  const choices = await gselChoices(locator);
  const at = choices.findIndex((choice) => choice.value === value);
  if (at < 0) throw new Error(`no choice "${value}" (${choices.map((c) => c.value).join(", ")})`);
  await locator.click();
  const page = locator.page();
  const item = page.locator(`.gsel-pop [data-act="gsel-pick"][data-i="${at}"]`);
  await item.scrollIntoViewIfNeeded();
  await item.click();
  await page.locator(".gsel-pop").waitFor({ state: "detached" });
}
