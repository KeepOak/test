/**
 * A small stand-in for GitHub's REST API over a local bare repository, for the self-development loop
 * proof (tests/selfdev-loop.test.mjs, scripts/selfdev-proof.mjs). It is not a mock of answers: pull
 * requests point at real commits in the bare repository, "CI" really runs the pushed head's test file
 * in a throwaway clone, and a merge really merges into the bare repository's base branch.
 *
 * CI registers the way GitHub's does: both workflow runs exist as soon as the pull request is opened,
 * while their check runs appear later (the fast one first) and finish later still, so a reader that
 * treats "nothing yet" or "the fast one passed" as green is caught. Every merge attempt is recorded
 * with what CI looked like at that moment.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run("git", args, { cwd, windowsHide: true, maxBuffer: 4 << 20 })).stdout.trim();

/**
 * @param {{ bare: string, repo: string, token: string, testFile: string,
 *   timing?: { fastAfterMs?: number, fastDoneMs?: number, slowAfterMs?: number } }} options
 */
export async function startFakeGitHub(options) {
  const timing = { fastAfterMs: 1500, fastDoneMs: 3000, slowAfterMs: 4000, ...options.timing };
  const pulls = new Map();
  const checks = new Map(); // sha -> { runs: [], workflows: [] }
  const mergeAttempts = [];
  const requests = [];
  const outputs = new Map(); // sha -> what its test run printed, for the job log
  const reruns = [];
  let nextId = 1000;
  let closed = false;
  const timers = new Set();
  const later = (ms, work) => { const timer = setTimeout(() => { timers.delete(timer); if (!closed) void work(); }, ms); timers.add(timer); };

  const resolveRef = async (ref) => {
    if (/^[0-9a-f]{40}$/.test(ref)) return (await git(options.bare, "cat-file", "-t", ref).catch(() => "")) === "commit" ? ref : null;
    return git(options.bare, "rev-parse", "--verify", `refs/heads/${ref}^{commit}`).catch(() => null);
  };

  /** CI for one head: two workflow runs at once, their checks later, the slow one really running the test file. */
  function startCi(sha) {
    if (checks.has(sha)) return;
    const state = { runs: [], workflows: [
      { id: nextId++, name: "PR Fast Checks", head_sha: sha, status: "queued", conclusion: null, event: "pull_request" },
      { id: nextId++, name: "Checks", head_sha: sha, status: "queued", conclusion: null, event: "pull_request" },
    ] };
    checks.set(sha, state);
    const [fastFlow, slowFlow] = state.workflows;
    later(timing.fastAfterMs, async () => {
      fastFlow.status = "in_progress";
      state.runs.push({ id: nextId++, name: "verify-fast", head_sha: sha, status: "in_progress", conclusion: null, app: { id: 15368 } });
    });
    later(timing.fastDoneMs, async () => {
      const fast = state.runs.find((row) => row.name === "verify-fast");
      if (fast) Object.assign(fast, { status: "completed", conclusion: "success" });
      Object.assign(fastFlow, { status: "completed", conclusion: "success" });
    });
    later(timing.slowAfterMs, async () => {
      slowFlow.status = "in_progress";
      const test = { id: nextId++, name: "test (node)", head_sha: sha, status: "in_progress", conclusion: null, app: { id: 15368 } };
      const promote = { id: nextId++, name: "promote", head_sha: sha, status: "completed", conclusion: "skipped", app: { id: 15368 } };
      state.runs.push(test, promote);
      const passed = await runTests(sha);
      test.log = outputs.get(sha) ?? "";
      Object.assign(test, { status: "completed", conclusion: passed ? "success" : "failure" });
      state.runs.push({ id: nextId++, name: "verify-suite", head_sha: sha, status: "completed", conclusion: passed ? "success" : "failure", app: { id: 15368 } });
      Object.assign(slowFlow, { status: "completed", conclusion: passed ? "success" : "failure" });
    });
  }

  /** The pushed head's own test file, in a throwaway clone: red is real. */
  async function runTests(sha) {
    const dir = await mkdtemp(join(tmpdir(), "fake-ci-"));
    try {
      await git(dir, "clone", "--quiet", options.bare, "work");
      const work = join(dir, "work");
      await git(work, "checkout", "--quiet", sha);
      // Not as a child of a running test: node --test inside one reports to the parent and exits 0 whatever happened.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"));
      const done = await run(process.execPath, ["--test", options.testFile], { cwd: work, env, windowsHide: true, timeout: 120_000 });
      outputs.set(sha, `${done.stdout}${done.stderr}`);
      return true;
    } catch (error) { outputs.set(sha, `${error?.stdout ?? ""}${error?.stderr ?? ""}\nError: Process completed with exit code 1.`); return false; }
    finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined); }
  }

  const ciPending = (sha) => {
    const state = checks.get(sha);
    return !state || state.workflows.some((row) => row.status !== "completed") || state.runs.some((row) => row.status !== "completed");
  };
  const ciGreen = (sha) => {
    const state = checks.get(sha);
    return !!state && !ciPending(sha) && state.runs.every((row) => ["success", "skipped"].includes(row.conclusion))
      && state.workflows.every((row) => row.conclusion === "success");
  };

  async function pullJson(pull) {
    if (pull.state === "open") pull.headSha = (await resolveRef(pull.head)) ?? pull.headSha;
    const baseSha = await resolveRef(pull.base);
    const repo = { full_name: options.repo };
    return { number: pull.number, node_id: `PR_${pull.number}`, state: pull.state, draft: pull.draft, merged: pull.merged,
      mergeable: true, mergeable_state: ciGreen(pull.headSha) ? "clean" : "unstable", title: pull.title, body: pull.body,
      html_url: `https://github.invalid/${options.repo}/pull/${pull.number}`,
      head: { ref: pull.head, sha: pull.headSha, repo }, base: { ref: pull.base, sha: baseSha, repo }, merge_commit_sha: pull.mergeSha ?? null };
  }

  async function merge(pull, body) {
    const snapshot = { at: Date.now(), number: pull.number, sha: body?.sha ?? null, pending: ciPending(pull.headSha), green: ciGreen(pull.headSha) };
    mergeAttempts.push(snapshot);
    if (pull.state !== "open" || pull.merged) return [405, { message: "Pull Request is not mergeable" }];
    if (body?.sha && body.sha !== pull.headSha) return [409, { message: "Head branch was modified. Review and try the merge again." }];
    const dir = await mkdtemp(join(tmpdir(), "fake-merge-"));
    try {
      await git(dir, "clone", "--quiet", options.bare, "work");
      const work = join(dir, "work");
      await git(work, "checkout", "--quiet", pull.base);
      await git(work, "-c", "user.name=Fake GitHub", "-c", "user.email=fake@github.invalid", "merge", "--no-ff", "--quiet", "-m", `Merge pull request #${pull.number}`, pull.headSha);
      await git(work, "push", "--quiet", "origin", `HEAD:refs/heads/${pull.base}`);
      const sha = await git(work, "rev-parse", "HEAD");
      Object.assign(pull, { merged: true, state: "closed", mergeSha: sha });
      snapshot.merged = true;
      return [200, { merged: true, sha, message: "Pull Request successfully merged" }];
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined); }
  }

  const prefix = `/repos/${options.repo}`;
  async function route(method, url, body) {
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.startsWith(prefix)) return [404, { message: "Not Found" }];
    const rest = path.slice(prefix.length);
    let match;
    if (method === "POST" && rest === "/pulls") {
      const headSha = await resolveRef(body.head), baseSha = await resolveRef(body.base);
      if (!headSha || !baseSha) return [422, { message: "Validation Failed: head or base does not exist" }];
      const pull = { number: pulls.size + 1, title: String(body.title ?? ""), body: String(body.body ?? ""), head: body.head, base: body.base,
        headSha, state: "open", draft: body.draft === true, merged: false };
      pulls.set(pull.number, pull);
      startCi(headSha);
      return [201, await pullJson(pull)];
    }
    if ((match = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pull = pulls.get(Number(match[1]));
      if (!pull) return [404, { message: "Not Found" }];
      if (method === "PATCH") { if (body.state === "closed") pull.state = "closed"; return [200, await pullJson(pull)]; }
      if (pull.state === "open") { const head = await resolveRef(pull.head); if (head && head !== pull.headSha) { pull.headSha = head; startCi(head); } }
      return [200, await pullJson(pull)];
    }
    if (method === "PUT" && (match = /^\/pulls\/(\d+)\/merge$/.exec(rest))) {
      const pull = pulls.get(Number(match[1]));
      return pull ? merge(pull, body) : [404, { message: "Not Found" }];
    }
    if ((match = /^\/commits\/([^/]+)$/.exec(rest))) {
      const sha = await resolveRef(decodeURIComponent(match[1]));
      return sha ? [200, { sha }] : [422, { message: "No commit found" }];
    }
    if ((match = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(rest))) {
      const rows = checks.get(match[1])?.runs ?? [];
      const page = Number(url.searchParams.get("page") ?? 1), size = Number(url.searchParams.get("per_page") ?? 30);
      return [200, { total_count: rows.length, check_runs: rows.slice((page - 1) * size, page * size).map((row) => ({ ...row, details_url: "" })) }];
    }
    if ((match = /^\/commits\/([0-9a-f]{40})\/status$/.exec(rest)))
      return [200, { sha: match[1], state: "pending", total_count: 0, statuses: [] }];
    if (rest === "/actions/runs") {
      const sha = url.searchParams.get("head_sha") ?? "";
      const rows = checks.get(sha)?.workflows ?? [];
      return [200, { total_count: rows.length, workflow_runs: rows }];
    }
    // A job's log: GitHub answers with a short-lived address on its own storage, reached without the token.
    if (method === "GET" && (match = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest))) {
      const found = [...checks.values()].flatMap((state) => state.runs).find((row) => row.id === Number(match[1]));
      return found ? [302, { location: `/storage/logs/${found.id}` }] : [404, { message: "Not Found" }];
    }
    if (method === "POST" && (match = /^\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(rest))) {
      const sha = [...checks.entries()].find(([, state]) => state.workflows.some((row) => row.id === Number(match[1])))?.[0];
      if (!sha) return [404, { message: "Not Found" }];
      reruns.push({ sha, run: Number(match[1]) });
      checks.delete(sha);
      startCi(sha);
      return [201, {}];
    }
    if ((match = /^\/rules\/branches\/(.+)$/.exec(rest))) return [200, []];
    if ((match = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest))) {
      const [, base, head] = match;
      const contains = await git(options.bare, "merge-base", "--is-ancestor", base, head).then(() => true, () => false);
      const behind = Number(await git(options.bare, "rev-list", "--count", `${head}..${base}`).catch(() => "1"));
      return [200, { status: base === head ? "identical" : contains ? "ahead" : "diverged", behind_by: behind, base_commit: { sha: base } }];
    }
    if ((match = /^\/branches\/(.+)$/.exec(rest)) && method === "GET") {
      const name = decodeURIComponent(match[1]);
      if (name.endsWith("/protection")) return [404, { message: "Branch not protected" }];
      const sha = await resolveRef(name);
      return sha ? [200, { name, protected: false, commit: { sha } }] : [404, { message: "Branch not found" }];
    }
    return [404, { message: "Not Found" }];
  }

  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", async () => {
      const url = new URL(request.url ?? "/", "http://fake");
      requests.push({ method: request.method, path: url.pathname });
      let status = 500, payload = { message: "fake GitHub failed" };
      const stored = /^\/storage\/logs\/(\d+)$/.exec(url.pathname);
      if (stored) {
        // The storage address carries its own short-lived permission; the token must never be sent there.
        const found = [...checks.values()].flatMap((state) => state.runs).find((row) => row.id === Number(stored[1]));
        const sentToken = !!request.headers.authorization;
        response.writeHead(found && !sentToken ? 200 : 403, { "content-type": "text/plain" });
        response.end(found && !sentToken ? String(found.log ?? "").split("\n").map((line) => `2026-09-28T10:00:00.0000000Z ${line}`).join("\n") : "denied");
        return;
      }
      try {
        if (request.headers.authorization !== `Bearer ${options.token}`) [status, payload] = [401, { message: "Bad credentials" }];
        else [status, payload] = await route(request.method ?? "GET", url, text ? JSON.parse(text) : undefined);
      } catch (error) { payload = { message: error instanceof Error ? error.message : String(error) }; }
      if (status === 302) { response.writeHead(302, { location: payload.location }); response.end(); return; }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    apiBase: `http://127.0.0.1:${address.port}/`,
    pulls, mergeAttempts, requests, reruns,
    ciPending, ciGreen,
    close: async () => {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
