import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const reviewed = new Map([
  ["actions/checkout", ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"]],
  ["actions/setup-node", ["820762786026740c76f36085b0efc47a31fe5020", "v7.0.0"]],
  ["actions/setup-python", ["5fda3b95a4ea91299a34e894583c3862153e4b97", "v7.0.0"]],
  ["actions/cache", ["55cc8345863c7cc4c66a329aec7e433d2d1c52a9", "v6.1.0"]],
  ["actions/upload-artifact", ["043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "v7.0.1"]],
  ["actions/download-artifact", ["3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", "v8.0.1"]],
  // Composite; it runs actions/attest v4.2.1 (Node 24). Only the release's publish job uses it.
  ["actions/attest-build-provenance", ["4d101475d8b20a2381f78447822ac1eab6504dd8", "v4.2.2"]],
]);

function inspectActionPins(source, file) {
  // The inspector below accepts plain values only; quoted values must fail closed, not vanish.
  const declared = [...source.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]+['"]?actions\//gm)].length;
  let inspected = 0;
  for (const match of source.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]+(actions\/[\w-]+)@([^\s#]+)(?:[ \t]+#[ \t]+(v\S+))?/gm)) {
    inspected++;
    const expected = reviewed.get(match[1]);
    assert.ok(expected, `${file} uses an unreviewed first-party action: ${match[1]}`);
    assert.deepEqual([match[2], match[3]], expected, `${file} must pin ${match[1]} to its reviewed Node 24 release`);
  }
  assert.equal(inspected, declared, `${file} has an uninspected first-party action`);
  return inspected;
}

test("every workflow pins the reviewed Node 24 action releases by immutable commit", async () => {
  const folder = join(".github", "workflows");
  const files = (await readdir(folder)).filter((name) => name.endsWith(".yml"));
  let uses = 0;
  for (const file of files) {
    const source = await readFile(join(folder, file), "utf8");
    uses += inspectActionPins(source, file);
  }
  assert.ok(uses > 0, "the first-party workflow action review must inspect action references");
});

test("a name-first action step cannot hide a changed pin", () => {
  const line = "  - name: Download\n    uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n";
  assert.equal(inspectActionPins(line, "fixture.yml"), 1);
  assert.throws(() => inspectActionPins(line.replace("3e5f45b2", "deadbeef"), "fixture.yml"),
    /must pin actions\/download-artifact/);
});

test("quoted first-party actions fail closed rather than escaping the pin count", () => {
  for (const quote of ["'", '"']) {
    for (const pin of ["3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", "v8", "deadbeef"]) {
      const line = `  - uses: ${quote}actions/download-artifact@${pin}${quote} # v8.0.1\n`;
      assert.throws(() => inspectActionPins(line, "quoted.yml"), /uninspected first-party action/,
        "quoted syntax must require inspection, even when its pin happens to be reviewed");
    }
  }
});
