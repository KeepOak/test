import type { Completion, CompletionRequest, Provider } from "./contracts.js";

export const demoProviderName = "offline-demo-fixture";
/**
 * A deterministic protocol fixture for tests. It does not interpret arbitrary requests. Branch never offers it and
 * never falls back to it: a test passes it in (`createBranch({ provider })`, `BRANCH_PROVIDER=demo`), or gets it as
 * createBranch's default only while running under Node's test runner (src/index.ts `testFixturePresets`).
 */
export class DemoProvider implements Provider {
  readonly name = demoProviderName;
  audio(): null {
    return null;
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    request.signal.throwIfAborted();
    const lastUser = request.messages.findLastIndex((m) => m.role === "user");
    const results = request.messages
      .slice(lastUser + 1)
      .filter((m) => m.role === "tool");
    const path = "branch-demo.txt",
      content = "Hello from Branch.\n";
    const steps = [
      ["files.write", { path, content }],
      ["files.read", { path }],
      ["files.verify", { path, expected: content }],
    ] as const;
    const step = steps[results.length];
    // Each step says which step it is. The same words every round read as a stuck model to the owner's
    // progress check (src/safety-extras/progress-judge.ts), which ended the update check on a copy of a
    // real install whose owner had switched that check on.
    if (step)
      return {
        content: `Deterministic demo fixture: step ${results.length + 1} of ${steps.length}, ${step[0]}.`,
        toolCalls: [
          {
            id: `demo-${results.length}`,
            name: step[0],
            arguments: JSON.stringify(step[1]),
          },
        ],
      };
    const verified = results.at(-1)?.content.includes('"verified":true');
    return {
      content: verified
        ? "Demo fixture completed: wrote, read, and verified branch-demo.txt."
        : "Demo fixture could not verify the file; inspect tool errors.",
      toolCalls: [],
    };
  }
}
