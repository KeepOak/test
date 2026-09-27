# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## What is signed

- The Windows setup file, `Branch-Agent-Setup-windows-x64.exe`.
- The program file inside every Windows download, `Branch Agent.exe`.

Both are attached to the project's [releases](https://github.com/stabrea/Branch-Agent/releases).

## Built from source, by CI only

- Every signed file is built from this repository's source by its own GitHub Actions workflow, `.github/workflows/package.yml`, on GitHub-hosted build machines.
- Signing runs only for a pushed version tag (`vX.Y.Z`). It never runs for a build started by hand, for a rehearsal tag or for a pull request.
- A version tag is built only when that exact commit is in the integration branch and has passed the project's checks.
- Nothing built on a personal computer is ever signed.
- Before anything is published, each installer is installed and started once on a clean build machine. Every download goes up with its SHA-256 checksum and a GitHub build provenance record.

## Roles

| Role | People |
| --- | --- |
| Committers and reviewers | Taofik Bishi ([@stabrea](https://github.com/stabrea)) |
| Approvers | Taofik Bishi ([@stabrea](https://github.com/stabrea)) |

- Changes reach the integration branch only through reviewed pull requests.
- Every signing request is approved by an approver.
- Everyone in these roles uses multi-factor sign-in on GitHub and on SignPath.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

What stays on the computer, and what leaves it only when you ask:

- **Your data stays on this computer.** That covers your conversations, your files and everything Branch remembers. Branch sends the project no telemetry and no usage data.
- **Tasks you give it.** Branch sends what the task needs to two kinds of place:
  - the model service you chose to connect (or a model running on your own computer or network);
  - the services that task uses that you connected yourself, such as a mail, calendar or chat account, or a web search.
- **Updates.** Branch looks on GitHub (`api.github.com`, `github.com`) for a newer version only in two cases: when you press Check, or when you turned on automatic updates in Settings. You can turn automatic updates off there.
  - The Beta channel is opt-in. It downloads Branch's source code from GitHub and its packages from the npm registry.
- **Usage counts.** These are off unless the owner says yes. They go only to an address of the owner's own, never to the project.

The services you connect have their own privacy policies. The ones Branch itself uses for updates are the [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) and the [npm privacy policy](https://docs.npmjs.com/policies/privacy).

## Licence

Branch Agent is open source under the [MIT License](LICENSE).
