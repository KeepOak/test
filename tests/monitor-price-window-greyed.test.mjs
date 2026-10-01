// Check that all price watch inputs and buttons are registered as live.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("price-watch: all inputs and actions are marked live", () => {
  // Read the module
  const source = readFileSync("public/app/flows/price-watch.js", "utf8");
  
  // Expected registrations for inputs (sw: prefix)
  const expectedInputs = [
    "sw:pw-item",
    "sw:pw-url",
    "sw:pw-label",
    "sw:pw-marker",
    "sw:pw-currency",
    "sw:pw-below",
    "sw:pw-decimals",
    "sw:pw-separator",
    "sw:pw-every"
  ];
  
  // Expected registrations for actions (direct names)
  const expectedActions = [
    "pricewatch-new",
    "pricewatch-save",
    "pricewatch-history"
  ];
  
  // Extract the markLive call
  const markLiveMatch = source.match(/markLive\(\[([^\]]+)\]\)/);
  assert.ok(markLiveMatch, "markLive call found");
  
  // Parse the registered items
  const registered = markLiveMatch[1]
    .split(",")
    .map(s => s.trim())
    .map(s => s.replace(/^["']|["']$/g, ""))
    .filter(s => s);
  
  // Check all inputs are registered
  for (const input of expectedInputs) {
    assert.ok(registered.includes(input), `Input ${input} is registered in markLive`);
  }
  
  // Check all actions are registered
  for (const action of expectedActions) {
    assert.ok(registered.includes(action), `Action ${action} is registered in markLive`);
  }
});
