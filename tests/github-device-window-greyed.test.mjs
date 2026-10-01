// Check that all GitHub device connection inputs and buttons are registered as live.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("github-device: all inputs and actions are marked live", () => {
  // Read the module
  const source = readFileSync("public/app/settings/github-device.js", "utf8");

  // Expected registrations for this feature
  const expectedInputs = ["sw:github-device-client"];
  const expectedActions = [
    "github-device-save",
    "github-device-begin",
    "github-device-disconnect",
    "github-device-cancel"
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
