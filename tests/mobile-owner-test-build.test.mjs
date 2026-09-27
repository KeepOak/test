import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import YAML from "yaml";

test("owner test is manual, isolated from release signing and retained only briefly", async () => {
  const source = await readFile(".github/workflows/mobile.yml", "utf8");
  const workflow = YAML.parse(source), job = workflow.jobs["android-owner-test"];
  assert.equal(workflow.on.workflow_dispatch.inputs.owner_test.default, false);
  assert.match(job.if, /github.event_name == 'workflow_dispatch' && inputs.owner_test/);
  assert.equal(job.environment, undefined, "candidate code cannot enter the release environment");
  assert.doesNotMatch(YAML.stringify(job), /secrets\.|releaseKey|ensureKeystore|package-mobile\.mjs --android/);
  assert.equal(job["timeout-minutes"], 15);
  const artifact = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(artifact.with["retention-days"], 7);
  assert.match(artifact.with.name, /github.sha/);
  assert.match(YAML.stringify(job), /apksigner.*verify/);
  assert.equal(workflow.jobs.android.if, "${{ !inputs.owner_test }}");
  assert.equal(workflow.jobs.ios.if, "${{ !inputs.owner_test }}");
});

test("the disposable test app cannot replace the future release installation", async () => {
  const gradle = await readFile("apps/mobile/android/app/build.gradle", "utf8");
  assert.match(gradle, /debug \{\s+applicationIdSuffix "\.test"\s+versionNameSuffix "-test"\s+resValue "string", "app_name", "Branch Test"/);
  assert.match(gradle, /applicationId "com.keepoak.branchagent"/);
  assert.match(gradle, /if \(releaseStore\) signingConfig signingConfigs.release/);
});

test("native share alias resolution survives a separate test application ID", async () => {
  const inbox = await readFile("apps/mobile/android/app/src/main/java/com/keepoak/branchagent/BranchShareInbox.java", "utf8");
  const plugin = await readFile("apps/mobile/android/app/src/main/java/com/keepoak/branchagent/BranchPhonePlugin.java", "utf8");
  assert.doesNotMatch(inbox, /context\.getPackageName\(\)\s*\+\s*"\.ShareTarget"/);
  assert.doesNotMatch(plugin, /new ComponentName\(context, context\.getPackageName\(\) \+ name\)/);
  assert.match(inbox, /BranchComponents\.component\(context, "\.ShareTarget"\)/);
});
