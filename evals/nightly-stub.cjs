// The nightly run's last word when evals/nightly.mjs could not write one itself (it failed to start, or crashed before
// its own "did not run" line): today's page in the coordination repo says the night ran and why nothing was scored, so
// a silent night is never mistaken for a green one. A page nightly.mjs already wrote today is left as it is.
//   node evals/nightly-stub.cjs "<reason>"      (EVAL_COORD_DIR picks the coordination repo, as in nightly.mjs)
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const COORD = process.env.EVAL_COORD_DIR || "C:/Users/bishi/Code/branch-agent-work-coord";
const reason = process.argv[2] || "the nightly run stopped before writing a scorecard";
const date = new Date().toISOString().slice(0, 10);
const dir = path.join(COORD, "evals");
const page = path.join(dir, `${date}.md`);

if (fs.existsSync(page)) {
  console.log(`${page} was already written tonight; left as it is`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(page, `# Branch evals \u2014 ${date}\n\n**Did not run:** ${reason}\n`);
const git = (...args) => execFileSync("git", args, { cwd: COORD, stdio: "inherit" });
try {
  git("pull", "--rebase"); // other work lands in this repo too; never force-push
  git("add", "evals");
  git("commit", "-m", `evals(${date}): did not run`);
  git("push");
} catch (error) {
  console.error(`the "did not run" page is written but not pushed: ${error.message}`);
}
process.exit(1);
