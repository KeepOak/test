<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/mascot-night.png">
    <img src="docs/images/mascot.png" alt="Branch Agent's mascot: a small round green sprout with big green eyes, standing on root feet, with copper branches that end in glowing lanterns." width="280">
  </picture>
</p>

# Branch Agent

Branch Agent is a personal assistant that runs on your own Windows computer. You ask for something in
plain words; it works out which of its tools the job needs, does the work a step at a time where you
can watch, and shows you exactly what it did and what it cost. Your conversations, your files and
everything it remembers stay on this machine — the only thing that leaves is what you actually send to
the model service you chose. It is open source, and it is an early implementation: what is built, what
is half-built and what will never be built are all written down in
[What Branch is not](docs/handbook/10-what-branch-is-not.md).

![The Branch Agent conversation screen: the rail of sections on the left, a conversation in the middle
with the tools it used, and the context pane on the right showing the model, receipts and what is
allowed.](docs/images/conversation.png)

## Install, in three steps

1. Download `Branch-Agent-windows-x64.zip`, `Branch-Agent-windows-x64.zip.sha256` and
   `Install Branch Agent.cmd` from the [latest release](https://github.com/stabrea/Branch-Agent/releases/latest),
   into the same folder. The installer refuses a missing or changed download.
2. Double-click **Install Branch Agent.cmd**. Windows may warn you the download is unsigned: choose
   **More info**, then **Run anyway**.
3. Open Branch Agent and connect a model — a ChatGPT plan, a key from any of 36 online services, or a model
   running on this very computer.

Nothing else has to be installed first. To remove it, use **Add or remove programs**; your
conversations and files are left where they are.

Running from source instead: Node.js 24.14.0 or newer (on the Node 25 line, 25.4.0 or newer) and npm,
then `npm ci && npm start`. Older Nodes are refused because Branch cannot hand them a proxy.

## The handbook

Written for someone who has never used a terminal. Start at the top.

| | Chapter | What is in it |
| --- | --- | --- |
| 00 | [Start here](docs/handbook/00-start-here.md) | Installing, your first task, and what the screen shows |
| 01 | [Connect a model](docs/handbook/01-connect-a-model.md) | Services, keys, models on this computer, and cost |
| 02 | [Everyday tasks](docs/handbook/02-everyday-tasks.md) | Asking, files, documents, pictures, voice, talk mode |
| 03 | [Your memory and knowledge](docs/handbook/03-your-memory-and-knowledge.md) | What it remembers, knowledge bases, and what leaves this computer |
| 04 | [Permissions and safety](docs/handbook/04-permissions-and-safety.md) | Approvals, rules, Lockdown, secrets, the lock, household profiles |
| 05 | [Reach it anywhere](docs/handbook/05-reach-it-anywhere.md) | Chat apps, your phone, and running in the background |
| 06 | [Automate](docs/handbook/06-automate.md) | Schedules, watches, workflows, flows, procedures, skills |
| 07 | [For builders](docs/handbook/07-for-builders.md) | The command line, the client library, MCP, plugins, benchmarks |
| 08 | [Troubleshooting](docs/handbook/08-troubleshooting.md) | The health check, diagnostics, updates, and what the messages mean |
| 09 | [Glossary](docs/handbook/09-glossary.md) | One name per idea, and the jargon each one replaces |
| 10 | [What Branch is not](docs/handbook/10-what-branch-is-not.md) | The honest list of what it does not do |

**Help is also in the app**: the **Help** entry in your own menu at the foot of the rail opens the
chapter for whatever screen you are on, and Ctrl+K finds any chapter by name.

For every setting, route and switch by name, see the [reference](docs/configuration.md). For how the
interface is put together, see [design.md](docs/design.md); for the architecture,
[architecture.md](docs/architecture.md).

## What is built and what is next

[The list](https://github.com/stabrea/Branch-Agent/issues/103) is the single page: what Branch can already do, what is being built right now, and
what is next in priority order. It is updated as work happens, not at the end.

## Contributing

Contributions can expand what Branch can do, make tasks more reliable, or supply representative
evaluation cases.

- Start a [discussion](https://github.com/stabrea/Branch-Agent/discussions) about use cases or design.
- Open an [issue](https://github.com/stabrea/Branch-Agent/issues) with a concrete proposal.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.
- See [ROADMAP.md](ROADMAP.md) for the proposed milestones.

Development checks:

```sh
npx playwright install chromium --only-shell
npm test
python -m unittest discover -s experiments -p 'test_*.py'
npm run doctor
```

## Code signing

Windows releases are signed for free through SignPath Foundation. How signed files are built, who approves them and what the app sends are in the [code signing policy](CODE_SIGNING_POLICY.md).

## Licence

Branch Agent is licensed under the [MIT License](LICENSE). You may use, modify, distribute and sell
the software, including as part of a commercial product, subject to the licence's notice
requirements. The licences of everything Branch Agent depends on are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), regenerated by `node scripts/dependency-notices.mjs`.
