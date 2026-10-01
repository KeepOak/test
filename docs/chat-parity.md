# Chat apps: parity with Hermes Agent and OpenClaw

This is the checklist for making every Branch messaging connection as capable as the best of Hermes Agent and
OpenClaw. Each row is one capability. Each cell says what Hermes Agent (**H**), OpenClaw (**O**) and Branch today
(**B**) do on that platform. It is updated as each piece lands.

Legend:
- ✅ has it
- ◐ partly (the note says what is missing)
- — does not have it, or the platform cannot do it
- ? not verified

Researched 2026-09-27. Sources:
- Hermes Agent (github.com/NousResearch/hermes-agent):
  - `website/docs/user-guide/messaging/*.md`
  - `gateway/run_turn_runner.py` (the progress bubble)
  - `agent/display.py` (tool verbs and emoji)
- OpenClaw (github.com/openclaw/openclaw):
  - `docs/channels/*.md`, `docs/channels/telegram/*.md` (including `mini-app.md`)
  - `docs/concepts/streaming.md`, `typing-indicators.md`, `queue.md`
- Branch: `src/channels/**`, `src/live-steps.ts`, `src/commands/catalog.ts`, `src/scheduler.ts`, `src/live-screen.ts`.

## Connection status when returning to Settings

Settings re-reads its current page when the owner returns through the gear, including after connecting or
removing an app in Customize. Ordinary redraws keep the page's data and do not register its actions or fetch
again. A failed channel read shows its error and keeps the last verified connection list; an initial failure does
not claim that no app is connected. A successful empty list still shows the empty state. Superseded reads cannot
overwrite a newer connection list or show an outdated error.

Implementation: `public/app/settings/settings.js` and `public/app/settings/pages/chatapps.js`.
Acceptance: `tests/settings-reentry.test.mjs` exercises return, removal, redraw and explicit page navigation;
`tests/chatapps-stale.test.mjs` covers failed initial reads, failed refreshes, successful empty reads and out-of-order responses, alongside
the existing lock/profile guards. `tests/chatapps-child-readers-stale.test.mjs` protects the child readers.

## Tested for real, app by app (CHAT-003)

The cells below mostly rest on stand-in adapters. This section says which apps also run against a **real server**,
with no account anywhere: Branch's own channel, built from a connections-file entry exactly as at start, talks to a
real server on this computer, and a person on the other side uses a small client of their own that shares no code
with Branch. The walk is the owner's: a stranger writes and gets a pairing code, the owner approves it, and the same
person asks a question with an accent and emoji in it and gets the answer back. An app that can only be sent to
(Gotify) gets Branch's own delivery instead, read back by the person's client. The model is a stand-in that echoes
the question, so what is real is the transport: the app's server, the connection, and Branch's adapter on it. A relay-less
app (Delta Chat) uses the mail server above, and the person's side is the app's own program.

How to run it (Windows with a WSL distro; `BRANCH_REAL_CHAT_WSL`, default `BranchCI`):

```
node scripts/real-chat/servers.mjs up     # fetch (pinned checksums), configure and start the servers
node scripts/real-chat/servers.mjs test   # run tests/real-chat.test.mjs against them
node scripts/real-chat/servers.mjs down
```

- Every server listens on 127.0.0.1 only, with no federation and throwaway passwords that exist only there.
- Downloads come to about 225 MB in all, none over 45 MB, each checked against a pinned SHA-256: Ergo 7 MB,
  GreenMail 11 MB, tuwunel 32 MB, ntfy 30 MB, deltachat-rpc-server 23 MB, nak 42 MB, smp-server 45 MB, simplex-chat
  12 MB, Gotify 12 MB, and from apt Prosody, Mosquitto and socat about 3 MB and the Mumble server 7.5 MB with its
  libraries.
- SimpleX's relay cannot bind one address, so it and both simplex-chat programs run in a network namespace of their
  own in the WSL distro; only the two programs' APIs are bridged out, to 127.0.0.1.
- Delta Chat's program checks the inbox on its own schedule, so its walk waits up to 90 s a step (usually about 3 s).
- Java 11 or later must already be installed for GreenMail; the script does not download it.
- CI has no servers, so there the real walks are skipped with a reason. The check that every catalog app has
  either a real test or a reason still runs in CI, and so does the check that this table is current.
- The first runs found two bugs in Branch's email reader, both fixed in #834:
  - A server may send a message's text before its headers, and GreenMail does about half the time. Branch read the
    headers as the text and dropped the mail.
  - IMAP counts a message in bytes. Branch counted characters, so a mail with a few accents or emoji made the inbox
    wait until it gave up, on every look, for good.

<!-- real-chat:start (written by node scripts/real-chat/table.mjs) -->

11 of 57 apps are tested for real; every other one says why not.

| App | Result | Server, or why not |
| --- | --- | --- |
| Telegram | Skipped | needs a bot token; Telegram's test environment only takes a bot made by a test-server user account, and making one is an account on Telegram's servers, which this harness never does |
| Discord | Skipped | needs a Discord bot token and a server to add it to; there is no local or sandbox server for it |
| Slack | Skipped | needs a Slack workspace and an app token; there is no local or sandbox server for it |
| WhatsApp Business | Skipped | needs a WhatsApp Business number (Meta Cloud API); there is no local or sandbox server for it |
| Email | **Real-tested** | GreenMail 2.1.14 (one Java jar, 11 MB) SMTP 127.0.0.1:13025 and IMAP 127.0.0.1:13143 |
| Facebook Messenger | Skipped | needs a Facebook Page and a Meta app; there is no local or sandbox server for it |
| Instagram | Skipped | needs an Instagram business account and a Meta app; there is no local or sandbox server for it |
| Matrix (Element) | **Real-tested** | tuwunel 1.9.3 (a Conduit fork, one Rust binary, 32 MB) in the BranchCI WSL distro on 127.0.0.1:16167 |
| Signal | Skipped | needs a phone number registered with Signal for signal-cli; Signal has no test server |
| Mattermost | Skipped | a local Mattermost server is a Docker image of about 1 GB (over the 100 MB limit without asking) |
| Rocket.Chat | Skipped | a local Rocket.Chat server needs MongoDB and a Docker image of about 1.5 GB (over the 100 MB limit without asking) |
| Google Chat | Skipped | needs a Google Workspace account and a Chat app; there is no local or sandbox server for it |
| Microsoft Teams (webhook) | Skipped | needs a Microsoft 365 tenant (incoming webhook); there is no local or sandbox server for it |
| Zulip | Skipped | a local Zulip server is a Docker install of several GB (over the 100 MB limit without asking) |
| Feishu / Lark | Skipped | needs a Feishu / Lark developer account; there is no local or sandbox server for it |
| DingTalk | Skipped | needs a DingTalk developer account; there is no local or sandbox server for it |
| WeCom (group robot) | Skipped | needs a WeCom (WeChat Work) organisation; there is no local or sandbox server for it |
| LINE | Skipped | needs a LINE Messaging API channel; there is no local or sandbox server for it |
| Viber | Skipped | needs a Viber bot account; there is no local or sandbox server for it |
| IRC | **Real-tested** | Ergo 2.19.1 (one Go binary, 7 MB) on 127.0.0.1:16667 |
| Twitch chat | Skipped | needs a Twitch account and an OAuth token; there is no local or sandbox server for it |
| Gotify | **Real-tested** | Gotify 3.1.1 (one Go binary, 12 MB) on 127.0.0.1:18080; send-only, so the walk is a delivery the person's client reads |
| iMessage | Skipped | needs a Mac with Messages signed in to an Apple ID |
| iMessage through BlueBubbles | Skipped | needs a Mac running the BlueBubbles server, signed in to an Apple ID |
| Microsoft Teams (bot) | Skipped | needs an Azure Bot registration; there is no local or sandbox server for it |
| Webex | Skipped | needs a Webex bot token; there is no local or sandbox server for it |
| Synology Chat | Skipped | needs a Synology NAS running Synology Chat |
| Zalo Official Account | Skipped | needs a Zalo Official Account; there is no local or sandbox server for it |
| Flock | Skipped | needs a Flock workspace and app; there is no local or sandbox server for it |
| Pumble | Skipped | needs a Pumble workspace and app; there is no local or sandbox server for it |
| Mastodon | Skipped | a local Mastodon server needs PostgreSQL, Redis and Ruby (several hundred MB; over the limit without asking) |
| Bluesky | Skipped | needs a Bluesky account (its local PDS needs Docker and DNS); there is no local or sandbox server for it |
| Reddit | Skipped | needs a Reddit account and a script app; there is no local or sandbox server for it |
| Discourse | Skipped | a local Discourse server is a Docker install of several GB (over the 100 MB limit without asking) |
| X direct messages | Skipped | needs an X developer account with Direct Message access; there is no local or sandbox server for it |
| Twist | Skipped | needs a Twist workspace and integration; there is no local or sandbox server for it |
| Nextcloud Talk | Skipped | a local Nextcloud with Talk needs a web server, PHP and a database (several hundred MB; over the limit without asking) |
| Text messages (Twilio) | Skipped | needs a Twilio phone number; there is no local or sandbox server for it |
| ntfy | **Real-tested** | ntfy 2.28.0 (one Go binary, 30 MB; its server does not run on Windows) in the BranchCI WSL distro on 127.0.0.1:18090 |
| Pushover | Skipped | needs a Pushover application token; there is no local or sandbox server for it |
| Threema Gateway | Skipped | needs a Threema Gateway ID (paid); there is no local or sandbox server for it |
| Home Assistant | Skipped | a local Home Assistant is several hundred MB of Python packages (over the limit without asking) |
| XMPP (Jabber) | **Real-tested** | Prosody 0.12 (apt, about 2 MB) in the BranchCI WSL distro, STARTTLS with a certificate from a throwaway local CA |
| MQTT | **Real-tested** | Mosquitto (apt, under 1 MB) in the BranchCI WSL distro on 127.0.0.1:11883 |
| Keybase | Skipped | needs a Keybase account signed in to the keybase program |
| SimpleX Chat | **Real-tested** | smp-server 6.5.0 (45 MB) and two simplex-chat 7.0.3 programs (12 MB .deb) in a network namespace of their own in the BranchCI WSL distro, each program's API bridged to 127.0.0.1 |
| Delta Chat | **Real-tested** | deltachat-rpc-server 2.62.0 (one Windows binary, 23 MB) on the GreenMail server above; the person is a second copy that joins by the assistant's invite |
| Nostr | **Real-tested** | an in-memory relay from nak 0.20.7 (one Go binary, 42 MB) on 127.0.0.1:17447; the person's client is nak too |
| VK | Skipped | needs a VK community token; there is no local or sandbox server for it |
| QQ (official bot) | Skipped | needs a QQ bot registration; there is no local or sandbox server for it |
| Guilded | Skipped | needs a Guilded bot token; there is no local or sandbox server for it |
| Revolt (Stoat) | Skipped | a local Revolt server is a Docker install of several services (over the 100 MB limit without asking) |
| Mumble | **Real-tested** | Mumble server 1.5 (apt, 7.5 MB with its libraries) in the BranchCI WSL distro on 127.0.0.1:16473, its own self-signed certificate |
| KOOK | Skipped | needs a KOOK bot token; there is no local or sandbox server for it |
| WeChat Official Account | Skipped | needs a WeChat Official Account; there is no local or sandbox server for it |
| WeCom app | Skipped | needs a WeCom organisation and self-built app; there is no local or sandbox server for it |
| WhatsApp (personal number) | Skipped | needs a phone with a WhatsApp account to link the bridge to; WhatsApp has no test server, and the harness never uses a real account |

<!-- real-chat:end -->

## What the two of them do, and what Branch takes

### The live progress message (Hermes, as the owner's Telegram screenshots show)
- **One message per task, edited in place.** One line per tool step: the tool's emoji, a verb, and the argument.
  Examples: "🔎 Searching files for auto_prune" and "📖 Reading MEMORY.md L1-500".
- **Edit rate.** At most one edit every 1.5 s (`EDIT_INTERVAL`, grammY's pattern). Updates that arrive in between
  are batched into the next edit.
- **Repeats.** Consecutive identical lines fold into one, with "(×N)" on the end.
- **Terminal commands** render as fenced code blocks.
  - On Telegram they render as `pre` blocks, with the language label and Telegram's copy button.
  - On Slack the fence has no language tag, because Slack prints the tag as a literal first line.
- **Overflow.** When the bubble would pass the platform's limit, a new bubble starts. Only the newest one is edited
  from then on.
- **Edit failures.** A flood-control reply ("retry after") backs off and keeps editing. Only a permanent failure
  stops editing, and later lines then go out as plain messages.
- **Platforms that cannot edit** (Signal, iMessage/BlueBubbles, SMS, email) get no progress bubbles at all: every
  update would be a new message.
- **Telegram notifications.** Progress, streaming chunks and status are sent with `disable_notification`. Only the
  final reply, approval prompts and command confirmations ring.

### OpenClaw's progress model
- **One editable "progress draft" per turn:** a headline, commentary and plan milestones. It is the default on
  Telegram and Slack; on Discord you opt in.
- **The rolling tool log** is opt-in (`progress.toolProgress`).
- **Raw command text is hidden by default** (`commandText: "status"`).
- **Slack** uses its native agent card, with updates merged at one per second.

### What Branch takes
- **Steps are shown.** Branch shows Hermes' line-per-step log with the command text, as the owner asked. It
  relies on:
  - the same scrub the window uses (`hideSecrets`, applied before anything is clipped);
  - the outbound guard every reply passes;
  - a direct-chat-only rule: a group never sees another person's paths and commands.

  This is a deliberate difference from OpenClaw's default, which hides command text.
- **One source for the lines.** They come from `liveSteps()` (src/live-steps.ts), the same lines and the same
  emoji table (`STEP_ICONS`) as the window, so a step looks the same everywhere. Nothing is invented per channel.

### The steps knobs (Settings › Chat apps › Steps in chats, src/channels/steps-display.ts)
Every knob is set for every app and can be set again for one app (by its connection id or its kind). All ship on.

| Knob | Values (default first) | Taken from |
|---|---|---|
| detail | all, new, verbose, off | Hermes `display.tool_progress` (off/new/all/verbose), per platform |
| grouping | one (edit one message), each (a message per step) | Hermes `tool_progress_grouping` (accumulate/separate) |
| lineChars | 120 (40 to 400) | OpenClaw `progress.maxLineChars` (120); Hermes `tool_preview_length` (40) is too short for paths. A sentence is cut at a word, a path in the middle so its file name stays (OpenClaw), a command at its end (Hermes) |
| commands | show, hide | OpenClaw `commandText` (raw/status); Branch shows commands as Hermes does |
| overflow | roll (a new message), trim ("(N earlier)") | Hermes rolls to a new bubble; OpenClaw keeps the newest lines |
| cleanup | off, on | Hermes `cleanup_progress`; OpenClaw deletes the Discord draft after the answer. A failed task keeps the message |
| noEdit | summary, each, off | Hermes skips apps without edits; OpenClaw sends only the answer. Branch adds one summary line above the reply |
| groups | kinds, off | Branch: a group sees counts of kinds, never a file or command |

The in-app window folds repeated finished lines with "(×N)" the same way (public/app/chat/livesteps.js).

### Every chat app: what the steps look like there
Generated from src/channels/steps-caps.ts; tests/chat-steps-channels.test.mjs builds all 55 adapters and checks each row
against its adapter, then renders one fixed task for every app.

<!-- steps-caps:start -->
| App | Edits | Code | Longest | Reactions | Replies | Hermes Agent | OpenClaw | Branch (as shipped) |
|---|---|---|---|---|---|---|---|---|
| Telegram (`telegram`) | yes | code blocks with a label and copy button | 3500 | yes | yes | off by default; all when on, one bubble edited every 1.5 s | progress draft edited in place (default) | One message, edited in place, a new one when it is full |
| Discord (`discord`) | yes | Markdown fences with the language | 2000 | yes | yes | all, one bubble edited | off by default; progress draft when chosen, deleted after the answer | One message, edited in place, a new one when it is full |
| Slack (`slack`) | yes | fences without a language | 3000 | yes | yes | off (Bolt posts are permanent) | native progress card in threads; typing reaction outside them | One message, edited in place, a new one when it is full |
| Matrix (`matrix`) | yes | HTML code blocks | 3500 | yes | yes | new (only when the tool changes) | draft preview edited in place | One message, edited in place, a new one when it is full |
| WhatsApp (`whatsapp`) | — | plain words | 4000 | yes | yes | new through the Baileys bridge; off on the Cloud API | final answer only | One summary line above the reply (plain words) |
| Signal (`signal`) | — | plain words | 2000 | yes | yes | off: no edits, so no progress | final answer only | One summary line above the reply (plain words) |
| Email (`email`) | — | plain words | 3500 | — | yes | off (batch delivery) | final answer only | One summary line above the reply (plain words) |
| Facebook Messenger (`messenger`) | — | plain words | 1900 | — | — | — | — | One summary line above the reply (plain words) |
| Instagram (`instagram`) | — | plain words | 1900 | — | — | — | — | One summary line above the reply (plain words) |
| SMS (Twilio) (`sms`) | — | plain words | 1600 | — | — | off (batch delivery) | — | Nothing added: each message costs money |
| iMessage (`imessage`) | — | plain words | 3000 | — | — | off: no edits, so no progress | final answer only | One summary line above the reply (plain words) |
| Microsoft Teams (bot) (`msteams-bot`) | — | plain words | 3500 | — | yes | — | native progress stream in personal chats | One summary line above the reply (plain words) |
| IRC (`irc`) | — | plain words | 2000 | — | — | — | — | One summary line above the reply (plain words) |
| Twitch chat (`twitch`) | — | plain words | 2000 | — | — | — | — | One summary line above the reply (plain words) |
| Gotify (`gotify`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| Webex (`webex`) | — | plain words | 3500 | — | yes | — | — | One summary line above the reply (plain words) |
| Synology Chat (`synology-chat`) | — | plain words | 2000 | — | — | — | — | One summary line above the reply (plain words) |
| Zalo (`zalo`) | — | plain words | 2000 | — | — | — | — | One summary line above the reply (plain words) |
| Flock (`flock`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| Pumble (`pumble`) | — | plain words | 3500 | — | yes | — | — | One summary line above the reply (plain words) |
| Mastodon (`mastodon`) | — | plain words | 420 | — | yes | — | — | One summary line above the reply (plain words) |
| Bluesky (`bluesky`) | — | plain words | 1000 | — | — | — | — | One summary line above the reply (plain words) |
| Reddit (`reddit`) | — | plain words | 3500 | — | yes | — | — | One summary line above the reply (plain words) |
| Discourse (`discourse`) | — | plain words | 3500 | — | yes | — | — | One summary line above the reply (plain words) |
| X direct messages (`x-dm`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| Twist (`twist`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| Nextcloud Talk (`nextcloud-talk`) | — | plain words | 3500 | — | yes | — | — | One summary line above the reply (plain words) |
| ntfy (`ntfy`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| Pushover (`pushover`) | — | plain words | 1024 | — | — | — | — | One summary line above the reply (plain words) |
| Threema (`threema`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| Home Assistant (`homeassistant`) | — | plain words | 3500 | — | — | off (batch delivery) | — | One summary line above the reply (plain words) |
| XMPP (`xmpp`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| MQTT (`mqtt`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| Keybase (`keybase`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| SimpleX (`simplex`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| Delta Chat (`deltachat`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| Nostr (`nostr`) | — | plain words | 3500 | — | yes | — | — | One summary line above the reply (plain words) |
| VK (`vk`) | — | plain words | 3500 | — | yes | — | — | One summary line above the reply (plain words) |
| QQ bot (`qq-bot`) | — | plain words | 3500 | — | yes | — | — | One summary line above the reply (plain words) |
| Guilded (`guilded`) | — | plain words | 3500 | — | yes | — | — | One summary line above the reply (plain words) |
| Revolt (`revolt`) | — | plain words | 2000 | yes | yes | — | — | One summary line above the reply (plain words) |
| Mumble (`mumble`) | — | plain words | 3500 | — | — | — | — | One summary line above the reply (plain words) |
| KOOK (`kook`) | — | plain words | 4000 | yes | yes | — | — | One summary line above the reply (plain words) |
| iMessage through BlueBubbles (`bluebubbles`) | — | plain words | 3000 | — | — | off: no edits, so no progress | final answer only | One summary line above the reply (plain words) |
| WhatsApp (personal number) (`whatsapp-web`) | — | plain words | 4000 | — | yes | new through the Baileys bridge | final answer only | One summary line above the reply (plain words) |
| WeChat Official Account (`wechat-mp`) | — | plain words | 600 | — | — | off: no edits, so no progress | — | One summary line above the reply (plain words) |
| WeCom app (`wecom-app`) | — | plain words | 600 | — | — | off; native stream message type instead | — | One summary line above the reply (plain words) |
| Mattermost (`mattermost`) | — | plain words | 4000 | — | yes | new (edits in place) | partial draft preview | One summary line above the reply (plain words) |
| Rocket.Chat (`rocketchat`) | — | plain words | 4000 | — | yes | — | — | One summary line above the reply (plain words) |
| Google Chat (`googlechat`) | — | plain words | 4000 | — | yes | — | — | One summary line above the reply (plain words) |
| Microsoft Teams (webhook) (`msteams`) | — | plain words | 4000 | — | yes | — | — | One summary line above the reply (plain words) |
| Zulip (`zulip`) | — | plain words | 4000 | — | yes | — | — | One summary line above the reply (plain words) |
| Feishu / Lark (`feishu`) | — | plain words | 4000 | — | yes | new (edits in place) | — | One summary line above the reply (plain words) |
| DingTalk (`dingtalk`) | — | plain words | 2000 | — | yes | off: no edits, so no progress | — | One summary line above the reply (plain words) |
| WeCom (webhook) (`wecom`) | — | plain words | 2000 | — | yes | — | — | One summary line above the reply (plain words) |
| LINE (`line`) | — | plain words | 4900 | — | yes | — | — | One summary line above the reply (plain words) |
| Viber (`viber`) | — | plain words | 7000 | — | yes | — | — | One summary line above the reply (plain words) |
<!-- steps-caps:end -->

## The matrix

Platforms: Telegram (TG), Discord (DC), Slack (SL), WhatsApp (WA), Signal (SG), iMessage/BlueBubbles (IM), Matrix (MX),
email (EM), SMS.

### Live progress message (edit in place, rate limits, fallback)
| | H | O | B today | Next for Branch |
|---|---|---|---|---|
| TG | ✅ 1.5 s edits, ×N, code blocks | ✅ progress draft (default) | ✅ (#565) Hermes lines from `liveSteps`, `pre`/`code` entities, ×N, summary line, sent quietly, `retry_after` waited out, 3 s in groups; overflow rolls to a new message; per-app knobs | |
| DC | ✅ | ✅ (opt-in) | ✅ (#568) the same lines, fences with the language, sent quietly (flag 4096), its 429 waited out | |
| SL | ✅ edits or native task cards | ✅ native agent card | ✅ (#568) the same lines, fences without a language | left: Slack's native agent card |
| WA | ✅ (Baileys bridge) | ? | ✅ (#568) the Cloud API cannot edit: one line above the reply ("📖×2 🔍 · ✅ Done · 3 steps · 12 s"), naming nothing | left: milestone lines for very long tasks |
| SG | — suppressed | ? | ✅ (#568) the line above the reply | |
| IM | — skipped | ◐ edit on macOS 13+ | ✅ (#568) the line above the reply | |
| MX | ✅ | ✅ | ✅ (#568) edits in place (`m.replace`), code as HTML, its 429 waited out | |
| EM | — | — | ✅ (#568) the line above the reply | |
| SMS | — | — | — by design: each text costs money (`paidPerMessage`), so nothing unasked is added | |
| Groups (all) | ◐ | ◐ | ✅ (#568) the short message counts kinds ("📖 Reading 2 files") and never shows a label, file, page or command | |

### Code blocks and copy (commands and paths)
| | H | O | B today |
|---|---|---|---|
| TG | ✅ fenced to MarkdownV2 `pre` | ◐ command text hidden by default | ✅ `pre` with language (label + Copy), `code` for files (#565) |
| DC | ✅ fences | ◐ | ✅ fences with the language (#568) |
| SL | ✅ fences, no tag | ◐ | ✅ fences without a tag (#568) |
| WA | ✅ ``` is native | ? | — |
| SG | ✅ `bodyRanges` monospace | ? | — |
| IM | — markdown stripped | ? | — |
| MX | ✅ formatted body | ? | ✅ `<pre><code class="language-…">` in `formatted_body` (#568) |
| EM, SMS | — plain text | — | — |

### Typing indicators
| | H | O | B today |
|---|---|---|---|
| TG | ✅ | ✅ | ✅ `sendChatAction` |
| DC | ✅ | ✅ | ✅ typing endpoint, refreshed while the task works |
| SL | ✅ "is thinking…" assistant status | ✅ + typing reaction | ✅ assistant status (`assistant.threads.setStatus`): "is thinking…", then the step in a DM ("is reading notes.md…"), "is working…" in a channel, cleared at the end; scrubbed, sent only on change, left alone after two refusals (needs Agents & AI Apps and `assistant:write`); plus the status reaction |
| WA | ✅ | ✅ | ✅ Cloud API typing indicator against the person's newest message (marks it read) |
| SG | ✅ (every 8 s) | ✅ | ✅ signal-cli `sendTyping`, asked again while the task works |
| IM | ✅ (Private API) | ✅ | — |
| MX | ✅ | ? | ✅ |
| EM, SMS | — | — | — |

### Streaming the final reply
| | H | O | B today |
|---|---|---|---|
| TG | ✅ edits or `sendMessageDraft` | ✅ `partial` | ✅ direct replies stream in a separate editable message; steps stay quiet and separate |
| DC | ✅ | ✅ | ✅ same shared reply stream |
| SL | ✅ native streaming | ✅ | ✅ shared message edits (native Slack streaming remains a separate adapter improvement) |
| WA | ✅ (bridge) | ? | — |
| MX | ✅ | ✅ | ✅ same shared reply stream |
| SG, IM, EM, SMS | — | — | — |

Branch sends the reply's first preview as a normal reply notification and edits it as it grows; it does not send
another copy at completion. Groups receive a complete reply and private progress summaries. Completed words pass
the secret scrub and outbound check before each preview; the unfinished trailing word stays buffered so split
credentials are checked whole. Long final replies reuse the first message and deliver the remaining chunks through
the ledger. Missing message IDs, failed edits and quick answers fall back to ordinary delivery. These paths are
proved against stand-in adapters and providers; real account connections remain unproven.

### Approvals by button (the exact request, by fingerprint)
| | H | O | B today |
|---|---|---|---|
| TG | ◐ exec approvals by typed yes/no; clarify questions by buttons | ✅ inline buttons | ✅ buttons carry the request's fingerprint |
| DC | ✅ buttons | ? | ✅ |
| SL | ✅ Block Kit | ✅ | ✅ Block Kit Yes / No buttons carrying the fingerprint (and the per-occurrence nonce for owner DM commands, shown fenced). A command Slack would draw differently (`<`, `>`, `&`, backtick) gets only No |
| WA | — typed (never polls) | ✅ 👍/👎 reactions | ✅ 👍/✅ or 👎/❌ on the question message, from the person asked, once (30 min), naming the question's fingerprint; typed y/n still works |
| SG | — | ✅ approval reactions | ✅ the same, matched to the question by this account's send timestamp |
| IM | ? | ? | ◐ typed `y` / `n`, or `/approve` and `/deny` (#658) |
| MX | ✅ reactions, limited to the requester | ✅ | ✅ the same, as an `m.annotation` on Branch's own question event |
| EM, SMS, others | — | — | ◐ typed `y` / `n`, or `/approve` (`/yes`) and `/deny` (`/no`) on every app (#658) |

### Voice notes in (transcribed) and out (spoken replies)
| | H in / out | O in / out | B today |
|---|---|---|---|
| TG | ✅ / ✅ voice bubble | ✅ / ? | ✅ in; ◐ out: `sendAudio` (an audio file, not a voice bubble) |
| DC | ✅ / ✅ (voice channels) | ✅ / ✅ | ✅ in; — out |
| SL | ✅ / ? | ? | — |
| WA | ✅ / ✅ | ✅ / ◐ calls, experimental | ✅ in; — out |
| SG | ✅ / ✅ as attachment | ? | ✅ in (`isVoiceNote`); ✅ out as a voice note (`voiceNote`) |
| IM | ? / ✅ | ? | ✅ in (audio messages); ◐ out: an audio file, not a recorded-audio bubble |
| MX | ✅ / ✅ | ✅ / ? | — |
| EM, SMS | — | — | — |

### Photos, files and documents, in and out
| | H | O | B today (in / out) |
|---|---|---|---|
| TG | ✅ | ✅ | ✅ / ✅ `sendDocument` (photos go out as documents) |
| DC | ✅ | ✅ | ✅ / ✅ |
| SL | ✅ | ✅ | — / ✅ |
| WA | ✅ | ✅ | — / — |
| SG | ✅ (100 MB) | ✅ | ✅ / ✅ (`getAttachment`; inline `data:` attachments, 50 MB) |
| IM | ✅ | ✅ | ✅ / ✅ (read only from the Messages attachments folder; sent by path from Branch's folder inside it) |
| MX | ✅ | ? | — / — |
| EM | ✅ attachments | ? | ✅ / ✅ (MIME read through `src/personal/mime.ts`; multipart/mixed out, 18 MB) |
| SMS | — | ◐ MMS | ✅ in: MMS pictures and files from Twilio's Media list, fetched only when answered / — out: Twilio fetches an MMS from a public web address, which Branch does not have |

### Forum topics and threads
| | H | O | B today |
|---|---|---|---|
| TG | ✅ forum topics, DM topics, `/topic` | ✅ topics are separate sessions | ✅ a topic is its own chat address |
| DC | ✅ auto-thread | ✅ | — |
| SL | ✅ | ✅ | ✅ thread replies |
| MX | ✅ | ✅ | — |
| EM | ✅ In-Reply-To / References | ? | ✅ |
| WA, SG, IM, SMS | — | — | — |

### Reactions as acks and status
| | H | O | B today |
|---|---|---|---|
| TG | — | ✅ ack reaction | ✅ 👀 → 🤔 → 👨‍💻 → 👍 / 😢 |
| DC | ✅ 👀 ✅ ❌ | ✅ | ✅ |
| SL | ✅ | ✅ | ✅ |
| WA | — | ✅ | ✅ the same status reactions on the person's message (WhatsApp keeps one per sender) |
| SG | ✅ | ✅ | ✅ signal-cli `sendReaction` on a message Branch received |
| IM | ✅ tapbacks | ✅ | — Messages' AppleScript cannot send a tapback |
| MX | ✅ | ✅ | ✅ `m.reaction` on the exact inbound event; own previous status is redacted before replacement (stand-in proof) |
| EM, SMS | — | — | — |

### Slash commands and menus
| | H | O | B today |
|---|---|---|---|
| TG | ✅ `setMyCommands` menu, inline picker | ✅ menu plus custom entries | ◐ typed commands: on as shipped in the owner's own paired DM (#653, #706), elsewhere behind the commands switch; no `setMyCommands` menu yet (#590, draft) |
| DC | ✅ native slash commands | ✅ | ✅ Branch's commands in Discord's own picker, built from the one command table and empty while commands are off (#670) |
| SL | ✅ native slash commands, `!cmd` in threads | ✅ | ✅ one `/branch <command>` slash command in the wizard's manifest, since many plain names are Slack's own (#670) |
| Others | ✅ typed | ✅ typed | ◐ typed, under the same rules as TG; `/approve` and `/deny` always (#658) |

### Edited messages (Settings › Chat apps › Edited messages)
| | H | O | B today |
|---|---|---|---|
| TG | ✅ | ✅ | ✅ `edited_message` |
| DC | ✅ | ✅ | ✅ `MESSAGE_UPDATE` with an edit time and changed words (a link unfolding is not an edit) |
| SL | ✅ | ✅ | ✅ `message_changed` from a person, words changed |
| MX | ✅ | ✅ | ✅ `m.replace` by the original message's own sender, of a message Branch read |
| WA, SG, IM | — | ◐ | — the Cloud API, signal-cli and Messages report no edits Branch can read |

### Long-message splitting
| | H | O | B today |
|---|---|---|---|
| All | ✅ numbered parts; fences kept valid | ✅ paragraph, then length; fences reopened | ✅ split at paragraph breaks, code blocks never left open |

### Formatting in each app (#592)
Settings › Chat apps › Formatting in each app chooses the app's own formatting or plain text, per app, and takes effect
at once. Plain text drops presentation markers but keeps code contents and link addresses: Telegram sends no entities,
Matrix no HTML, Slack plain-text blocks, and Discord escapes what is left and keeps a 1000-character budget so the
escaped text still fits its 2000-character limit. Hermes and OpenClaw convert Markdown per platform; neither offers a
per-app plain choice.

### What the Trunk sees and staying connected (#553)
| | H | O | B today |
|---|---|---|---|
| Edited messages | ◐ | ✅ | ✅ TG: the latest version is answered (a version arriving while its message is still gathered replaces it) |
| Albums as one message | ◐ | ✅ inbound batching | ✅ TG (`media_group_id`): an album's photos join one turn (at least 1 s); other apps: — |
| Wait for messages split in two | ◐ | ✅ 300 ms quiet window | ✅ every app: 0, 1 or 3 s (default 1 s); the same person's messages join the turn |
| Watchdog | ✅ | ✅ | ✅ TG: a poll with no answer for the "stalled after" time is started again; a restart that brings nothing back shows on the card |
| Online status in the app | — | — | ✅ TG `setMyShortDescription`: "Online" / "Offline, back soon" (off until chosen: it changes the bot's profile) |

### Reply-to / quote
| | H | O | B today |
|---|---|---|---|
| TG | ✅ | ✅ native quote excerpts | ✅ `reply_parameters` |
| DC | ✅ (`first` / `all`) | ✅ | ✅ `message_reference` |
| SL | ✅ threads | ✅ | ✅ thread |
| WA | ✅ quoted context and media | ✅ quote mode | ✅ `context.message_id` |
| SG | ✅ native quote | ? | ✅ `quoteTimestamp` and `quoteAuthor` of the person's message |
| IM | ? | ✅ `reply_to_guid` | — Messages' AppleScript has no reply-to |
| MX | ? | ✅ | ✅ `m.in_reply_to` the person's event, same room only |
| EM | ✅ | ? | ✅ |

Hermes Agent's `reply_to_mode` (off / first / all, default first) and OpenClaw's `replyToMode` (off / first / all /
batched, Telegram default off) decide whether an answer quotes. Branch has the same per-app choice under Settings ›
Chat apps › Replies in each app (`src/channels/reply-style.ts`), with one more that is its default: **auto** quotes in a
one-to-one chat only when a newer message came in before the answer went out (or the message was fetched late after a
restart), and quotes the first message of an answer in a group. One answer never quotes twice unless the owner chose
"every": the steps message and the reply below it are one answer. Only apps whose reply id is just a quote (Telegram,
Discord, WhatsApp, Revolt, Guilded, KOOK, Nextcloud Talk, VK; `ChannelAdapter.replyQuotes`) are affected; where the id
is the thread itself (Slack, email, Mastodon and the like) it is always kept. The reaction on the person's message is a
per-app switch on the same card.

### Ending a turn
A turn that took no step posts only its answer: Hermes sends its progress bubble only once a tool runs, and OpenClaw's
quiet progress mode posts nothing for a turn without one, so Branch no longer posts "✅ Done · 0 steps" as a message of
its own. A turn with steps keeps the steps message above the answer and edits it into its last line. Words the model
wrote before its first step, already streamed as the start of a reply, become the steps message, and the reply starts
again below it, so the order in the chat is always steps, then answer. `/start` is answered with a short welcome (who is
answering, on which computer, and the commands when they are on) without asking the model; Hermes answers it with
nothing.

### Per-chat model and Trunk
| | H | O | B today |
|---|---|---|---|
| All | ✅ `/model` (saved per chat); per-channel prompt and model overrides | ✅ agent bindings per channel or account | ◐ `/model` in chat, saved for that chat's conversation (same rule as the other commands); a chat linked to a Trunk's conversation. No picker menu yet (CHAT-079, #760 open) |

### Pairing and allowlists
| | H | O | B today |
|---|---|---|---|
| All | ✅ DM pairing code, allowlists, admins vs users | ✅ `dmPolicy` pairing / allowlist / open, group allowlists | ✅ 6-digit pairing the owner approves; one allowlist for every app; per-channel list |

### Group mention rules
| | H | O | B today |
|---|---|---|---|
| TG | ✅ mention patterns, reply to the bot | ✅ `requireMention` | ✅ mention or reply to the bot; per-channel `activation` |
| DC | ✅ `require_mention`, free-response channels | ✅ | ✅ mention or reply |
| SL | ✅ | ✅ | ✅ mention |
| SG, IM, MX | ✅ | ✅ | ◐ name in text (MX, IM); groups never addressed (SG) |
| WA | ✅ | ✅ | ◐ every message counts as addressed |

### Home channel and cron delivery
| | H | O | B today |
|---|---|---|---|
| All | ✅ `/sethome`; cron results go there | ✅ explicit delivery targets | ◐ a schedule can deliver to a named chat (`deliverTo`); no `/sethome` |

### Interrupting or steering a running task, `/stop`, session reset, usage
| | H | O | B today |
|---|---|---|---|
| Steer | ✅ interrupt / queue / steer | ✅ queue-steering | ✅ a message sent while a task works is a note to it (ships "when needed") |
| `/stop` | ✅ | ✅ | ◐ on in the owner's own paired DM as shipped (#653, #706); elsewhere the commands switch ships off (it reaches Branch from outside) |
| Reset | ✅ `/new`, `/reset` | ✅ | ◐ `/new` (same rule) |
| Usage | ✅ `/usage`, `/insights` | ✅ | ◐ `/usage` and a per-reply footer (same rule) |

### Live screen and remote control from a chat (owner request, 2026-09-27)
| | What the platform allows | H | O | B today |
|---|---|---|---|---|
| TG | `editMessageMedia` replaces a screenshot in place; inline keyboards; Mini App (WebApp) with signed `initData` | — | ◐ `/dashboard` Mini App (Tailscale only, owner `allowFrom`, signed `initData` checked) | ◐ a task's **browser** only (the computer's screen still refuses every door, `liveScreenDoorRefusal`): one picture replaced in place with Take over / Hand back, and a **Mini App** to drive it from the phone (`src/miniapp/`): Telegram's signed `initData` for the task's own person in their private chat, the App lock PIN for every session, a session held to that browser only (5 min idle, 30 min at most, ended by Lockdown or App lock), every hand-over and input on the task's record. It is served from its own loopback door, never Branch's port, and its button shows only while Tailscale forwards HTTPS to that door (Settings › Chat apps › Turn on phone access runs that one `tailscale serve` path after the owner has seen the exact command and said yes; Turn off removes it) |
| DC | edit a message's attachments; buttons | — | — | ◐ one picture replaced in place with Take over / Hand back |
| SL | a file can't be replaced in place (each view is a new post); buttons | — | — | — |
| WA | no edit (one picture per request); up to 3 reply buttons | — | — | — |
| MX | `m.replace` of an image event; reactions | — | — | — |
| SG, IM, EM, SMS | a picture only on request, no buttons: view only, no control | — | — | — |

Piece 5 builds this. Its rules:
- off by default;
- the owner's paired direct chat only;
- a fresh confirmation in the window or with the PIN for every session;
- refused under Lockdown and App lock, with a banner on screen while it is active;
- Stop from both sides, and an idle stop;
- every action audited;
- stand-in-desktop tests only.

### Commands in the owner's paired DM

Telegram and Discord now have a dedicated opt-in in Settings › Chat apps › Commands from your own chat. The owner
selects their own approved pairing IDs and confirms the current App lock PIN when set. The task remains a channel
task with every other owner-only tool refused. It gets only the configured `shell.execute` permission.

The command prompt shows the complete argument list, directory, key names and explicit execution options. Its Yes
names the exact fingerprint, works in the originating DM only, and is consumed by one execution. It continues the
task immediately. Plain `y`, truncated or redacted commands, groups, catch-up messages, other senders, revoked pairings,
Lockdown and App lock cannot approve it. Settings changes and resumed/helper executions recheck access.

Evidence: `tests/chat-owner-commands.test.mjs`, the existing channel security suites and the headless
`design/redesign/tools/verify-chat-owner-commands.cjs` exercise the real engine with stand-in chat, model and command
implementations. Actual account traffic is not proven by those tests. Slack/Matrix still need their button transport;
apps without authenticated sender identities continue to require the Branch window for command approval.
Discord's callback transport follows its [interaction documentation](https://docs.discord.com/developers/interactions/receiving-and-responding):
Gateway component events are acknowledged before work starts, and bot DMs are distinguished from private group channels.

## Every Branch adapter, by what it can do today

Read from `src/channels/*.ts`: which optional adapter methods each one has (router.ts `ChannelAdapter`). The ten
webhook services in `data/channels.json` share `webhook-chat` (send only): Mattermost, Rocket.Chat, Google Chat,
Microsoft Teams, Zulip, Feishu, DingTalk, WeCom, LINE and Viber.

| Adapter | Send | Edit | Typing | React | Buttons | Voice out | File out | Files in | Voice in | Max text |
|---|---|---|---|---|---|---|---|---|---|---|
| bluebubbles | yes | — | — | — | — | yes (audio file without the Private API) | yes | yes | yes | 3000 |
| bluesky | yes | — | — | — | — | — | — | — | — | 1000 |
| deltachat | yes | — | — | — | — | — | — | — | — | 3500 |
| discord | yes | yes | yes | yes | yes | — | yes | yes | yes | 2000 |
| discourse | yes | — | — | — | — | — | — | — | — | 3500 |
| email | yes | — | — | — | — | — | yes | yes | — | 3500 |
| flock | yes | — | — | — | — | — | — | — | — | 3500 |
| gotify | yes | — | — | — | — | — | — | — | — | 3500 |
| guilded | yes | — | — | — | — | — | — | — | — | 3500 |
| homeassistant | yes | — | — | — | — | — | — | — | — | 3500 |
| imessage | yes | — | — | — | — | yes (audio file) | yes | yes | yes | 3000 |
| irc | yes | — | — | — | — | — | — | — | — | 2000 |
| keybase | yes | — | — | — | — | — | — | — | — | 3500 |
| kook | yes | — | — | — | — | — | — | — | — | 4000 |
| mastodon | yes | — | — | — | — | — | — | — | — | default |
| matrix | yes | yes | yes | yes | — | — | — | — | — | 3500 |
| mqtt | yes | — | — | — | — | — | — | — | — | 3500 |
| mumble | yes | — | — | — | — | — | — | — | — | 3500 |
| nextcloud-talk | yes | — | — | — | — | — | — | — | — | default |
| nostr | yes | — | — | — | — | — | — | — | — | 3500 |
| ntfy | yes | — | — | — | — | — | — | — | — | 3500 |
| pumble | yes | — | — | — | — | — | — | — | — | 3500 |
| pushover | yes | — | — | — | — | — | — | — | — | 1024 |
| qq-bot | yes | — | — | — | — | — | — | — | — | 3500 |
| reddit | yes | — | — | — | — | — | — | — | — | 3500 |
| revolt | yes | — | — | — | — | — | — | — | — | 2000 |
| signal-cli | yes | — | — | — | — | yes | yes | yes | yes | 2000 |
| simplex | yes | — | — | — | — | — | — | — | — | 3500 |
| slack | yes | yes | — | yes | — | — | yes | — | — | 3000 |
| synology-chat | yes | — | — | — | — | — | — | — | — | 2000 |
| teams-bot | yes | — | — | — | — | — | — | — | — | 3500 |
| telegram | yes | yes | yes | yes | yes | yes | yes | yes | yes | default |
| threema | yes | — | — | — | — | — | — | — | — | 3500 |
| twilio-sms | yes | — | — | — | — | — | — | yes (MMS) | — | 1600 |
| twist | yes | — | — | — | — | — | — | — | — | 3500 |
| vk | yes | — | — | — | — | — | — | — | — | default |
| webex | yes | — | — | — | — | — | — | — | — | 3500 |
| webhook-chat (10 services) | yes | — | — | — | — | — | — | — | — | per service |
| wechat | yes | — | — | — | — | — | — | — | — | 600 |
| whatsapp | yes | — | — | — | — | — | — | — | yes | 4000 |
| x-dm | yes | — | — | — | — | — | — | — | — | 3500 |
| xmpp | yes | — | — | — | — | — | — | — | — | 3500 |
| zalo | yes | — | — | — | — | — | — | — | — | 2000 |

## Plan, in pieces (one pull request each)

1. **This matrix.** Done (#556); kept current with each merge.
2. **Telegram, the live progress message.** Done (#565): Hermes lines from `liveSteps()`, commands as `pre` "shell"
   blocks and paths as inline code, ×N folding and a summary line, `retry_after` honoured and a slower rate in groups,
   direct chats with a paired or allowed sender only, and "Show steps in chats" shipping on. Per-app steps knobs and
   rolling messages: #648.
3. **A channel-agnostic renderer with per-platform adapters.** Done (#568): Discord, Slack and Matrix edit in place
   with fences; WhatsApp, Signal, iMessage, email and SMS get one compact summary.
4. **The rest of the matrix, platform by platform:**
   - typing, reactions and buttons wherever the platform has them: done for TG, DC, SL and MX (#568, #624, #658, #720);
     answers by reaction on WhatsApp, Signal and Matrix (#716);
   - voice bubbles out: #590 (draft);
   - files in and out beyond Telegram: #664 (open);
   - threads: TG topics and SL threads done; DC and MX not started;
   - a command menu: DC and SL done (#670); TG `setMyCommands` in #590 (draft);
   - quote-replies: per-app choice in #700 (open);
   - `/sethome`: not started.
5. **Live screen and remote control from a chat** (security tier), under the rules above: #607 and #617 (drafts).
