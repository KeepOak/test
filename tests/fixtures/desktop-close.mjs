/** Close only the isolated desktop launched by this fixture, after its own engine has stopped. */
export async function closeOwnedDesktop(electron, home) {
  if (electron.process().exitCode !== null) return;
  await electron.evaluate(async (_electron, expectedHome) => {
    if (process.env.BRANCH_DESKTOP_HOME !== expectedHome || process.env.BRANCH_TEST_ENGINE_HOOKS !== "1")
      throw new Error("Refusing to close a desktop outside the isolated test home");
    const host = globalThis.branchEngineForTests;
    if (!host) throw new Error("The isolated desktop has no engine cleanup hook");
    await host.end(7000);
    if (host.running) throw new Error("The isolated desktop engine did not stop");
  }, home);
  await electron.close();
}
