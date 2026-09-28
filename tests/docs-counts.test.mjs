import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { providerCatalog } from "../dist/provider-catalog.js";
import { securityChecks } from "../dist/security-audit/audit.js";

/**
 * v0.12.0 audit #39: the documents contradicted each other and the code (38 services in one place, 44 in another; a
 * security check with more checks than it said). The counts the documents state are read from the code here, so a
 * number that drifts fails instead of shipping.
 */
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const numbers = (text, pattern) => [...text.matchAll(pattern)].map((match) => Number(match[1]));

test("every count the documents state matches the code", async () => {
  const services = providerCatalog().services;
  const online = services.filter((service) => service.kind === "cloud" && service.id !== "custom").length;
  const here = services.filter((service) => service.kind === "local").length;
  const docs = { readme: await read("README.md"), handbook: await read("docs/handbook/01-connect-a-model.md"), reference: await read("docs/configuration.md") };
  const all = Object.values(docs).join("\n");
  assert.deepEqual([...new Set(numbers(all, /knows (\d+) model services/g))], [services.length], "the size of the model catalog");
  assert.deepEqual([...new Set(numbers(all, /\((\d+) online, \d+ that run on this computer/g))], [online]);
  assert.deepEqual([...new Set(numbers(all, /\(\d+ online, (\d+) that run on this computer/g))], [here]);
  assert.deepEqual([...new Set(numbers(all, /any of (\d+) online services/g))], [online], "the services a key connects");
  assert.equal(numbers(all, /any of (\d+) services/g).length, 0, "no count of services without saying which");
  assert.deepEqual([...new Set(numbers(docs.reference, /runs (\d+) named checks/g))], [securityChecks.length], "the security check");
});
