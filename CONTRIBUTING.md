# Contributing to Branch Agent

Contributions are welcome: use cases, design feedback, documentation, tests, and implementation.

Use Node.js 24 and strict TypeScript for the application. Python 3.12 supports optional experiments. Install with `npm ci`, install the test browser with `npx playwright install chromium --only-shell`, then run `npm test`. Run the standard-library experiment tests with `python -m unittest discover -s experiments -p 'test_*.py'`.

Keep functions under 50 lines. Explain dependencies in terms of the capability they supply. Keep credentials, user workspaces, research downloads and local state outside commits. Update the relevant feature acceptance record when behavior changes; adding a tool name alone does not complete a capability.

## Pick something up without colliding

**Start at [the list](https://github.com/stabrea/Branch-Agent/issues/103).** It is the single page showing what is built, what is being
built right now, and what is next, in priority order rather than in order of what is quickest. It is
worked from the top down, so the next free bucket is the next thing to do.

Behind it sits one GitHub issue per theme, listed in the index,
[#42](https://github.com/stabrea/Branch-Agent/issues/42), holding the same work as individual rows
with ids like `A0245`. Several rows often describe the same missing thing under different names; the
list groups them so two people cannot pick up the same work by two different names. Read the boxes
like this:

| What you see | What it means |
| --- | --- |
| `- [ ] A0245 …` | Free. Nobody is on it. Take it. |
| `- [x] A0245 (0.15.0)` | Done and released in that version. |
| `- [x] A0245 (merged, ships in 0.17.0)` | Done, reviewed and merged already. Not released yet, so you cannot see it in a download, but the code and its test exist. Do not rebuild it. |
| A comment saying **Being built right now** | Someone is mid-branch on those items. The comment names them and the branch. Everything else in that issue is still free. |

Before starting anything that will take more than an afternoon, **say so on the theme issue** —
which ids you are taking and roughly when. A one-line comment is enough. It is the only thing that
stops two people building the same feature twice, and it costs you nothing.

A box is only ticked when a reviewer has named the source file and a test that asserts the
behaviour. A tool that exists but does nothing does not count, and a test that only checks a name
exists does not count either. Two audits of this list had to re-open items that were ticked on a
promise rather than on evidence; please do not add more.

## Propose a change

For a substantial change, open an issue describing:

1. The user problem and an example.
2. The proposed behavior.
3. How we can verify that it works.

Small documentation corrections can go directly into a pull request.

## Submit a pull request

1. Fork the repository and create a branch for your change.
2. Keep the change focused and explain any new dependencies.
3. Add relevant verification for behavior changes and run the available checks.
4. Describe what changed, why it helps, and how you verified it.

Use descriptive commits, such as `feat: add task routing` or `docs: clarify setup`.

To keep parallel pull requests from colliding: put new window styles in `public/app/styles/<area>.css` (linked from `public/index.html` after `app.css`, sorted by name), never at the end of `public/app.css`; keep `public/locales/*.json` sorted with `node scripts/locale-order.mjs`; and run `node scripts/setup-merge-drivers.mjs` once per clone so the locale files merge by key.

Maintainers review contributions and decide what is merged. Community participation does not require direct write access to the repository.

## Contribution terms

By submitting a contribution for inclusion in Branch Agent, you agree to license that contribution under the repository's MIT License. You retain ownership of your contribution.

Submit work you have the right to contribute. Do not include credentials, private user data, or material that cannot be distributed under the applicable terms.

## Working together

Be respectful, explain disagreements with evidence, and keep feedback focused on the work. Harassment and personal attacks are not welcome.
