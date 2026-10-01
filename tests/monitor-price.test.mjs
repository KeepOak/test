/**
 * Price watches: the price is read from one literal label on the page, and only a drop that lands below the owner's
 * threshold counts. A missing, doubled or differently priced field is an unknown price, never a price of zero.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PriceConditionSchema, extractPrice, observePrice } from "../dist/monitor-price.js";

const rule = PriceConditionSchema.parse({ item: "Blue kettle 1.7 L", currency: "USD", currencyMarker: "$", label: "Total:", below: 50 });
const page = (price) => `Blue kettle\nTotal: ${price}\nIn stock`;

test("a price watch alerts only on a drop below the threshold, and refuses a price it cannot read for sure", () => {
  assert.equal(extractPrice(page("$1,049.50"), rule), 1049.5);
  const euro = PriceConditionSchema.parse({ ...rule, currencyMarker: "€", decimalSeparator: "," });
  assert.equal(extractPrice(page("€1.049,50"), euro), 1049.5);

  const first = observePrice(rule, [], page("$60.00"), "2026-09-30T10:00:00.000Z");
  assert.equal(first.changed, false, "the first look is the baseline");
  const stillAbove = observePrice(rule, first.history, page("$55.00"), "2026-09-30T11:00:00.000Z");
  assert.equal(stillAbove.changed, false, "a drop that stays above the threshold is not news");
  const below = observePrice(rule, stillAbove.history, page("$49.99"), "2026-09-30T12:00:00.000Z");
  assert.equal(below.changed, true);
  assert.equal(below.previous, 55);
  assert.equal(observePrice(rule, below.history, page("$49.99"), "2026-09-30T13:00:00.000Z").changed, false, "the same price again is not sent twice");
  assert.equal(below.history.length, 3);

  assert.throws(() => extractPrice("Total: $10\nTotal: $12", rule), /more than once/);
  assert.throws(() => extractPrice("Subtotal $10", rule), /missing/);
  assert.throws(() => extractPrice(page("€10.00"), rule), /different currency/);
  assert.throws(() => extractPrice(page("$10.999"), rule), /number format/);
  assert.throws(() => PriceConditionSchema.parse({ ...rule, below: 9.999 }), /decimal places/);
});
