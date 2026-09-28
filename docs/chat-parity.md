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

## The matrix

Platforms: Telegram (TG), Discord (DC), Slack (SL), WhatsApp (WA), Signal (SG), iMessage/BlueBubbles (IM), Matrix (MX),
email (EM), SMS.

### Live progress message (edit in place, rate limits, fallback)
| | H | O | B today | Next for Branch |
|---|---|---|---|---|
| TG | ✅ 1.5 s edits, ×N, code blocks | ✅ progress draft (default) | ✅ (#565) Hermes lines from `liveSteps`, `pre`/`code` entities, ×N, summary line, sent quietly, `retry_after` waited out, 3 s in groups | left: roll to a new message on overflow (today "(N earlier)") |
| DC | ✅ | ✅ (opt-in) | ✅ (piece 3) the same lines, fences with the language, sent quietly (flag 4096), its 429 waited out | |
| SL | ✅ edits or native task cards | ✅ native agent card | ✅ (piece 3) the same lines, fences without a language | left: Slack's native agent card |
| WA | ✅ (Baileys bridge) | ? | ✅ (piece 3) the Cloud API cannot edit: one line above the reply ("📖×2 🔍 · ✅ Done · 3 steps · 12 s"), naming nothing | left: milestone lines for very long tasks |
| SG | — suppressed | ? | ✅ (piece 3) the line above the reply | |
| IM | — skipped | ◐ edit on macOS 13+ | ✅ (piece 3) the line above the reply | |
| MX | ✅ | ✅ | ✅ (piece 3) edits in place (`m.replace`), code as HTML, its 429 waited out | |
| EM | — | — | ✅ (piece 3) the line above the reply | |
| SMS | — | — | — by design: each text costs money (`paidPerMessage`), so nothing unasked is added | |
| Groups (all) | ◐ | ◐ | ✅ (piece 3) the short message counts kinds ("📖 Reading 2 files") and never shows a label, file, page or command | |

### Code blocks and copy (commands and paths)
| | H | O | B today |
|---|---|---|---|
| TG | ✅ fenced to MarkdownV2 `pre` | ◐ command text hidden by default | ✅ `pre` with language (label + Copy), `code` for files (#565) |
| DC | ✅ fences | ◐ | ✅ fences with the language (piece 3) |
| SL | ✅ fences, no tag | ◐ | ✅ fences without a tag (piece 3) |
| WA | ✅ ``` is native | ? | — |
| SG | ✅ `bodyRanges` monospace | ? | — |
| IM | — markdown stripped | ? | — |
| MX | ✅ formatted body | ? | ✅ `<pre><code class="language-…">` in `formatted_body` (piece 3) |
| EM, SMS | — plain text | — | — |

### Typing indicators
| | H | O | B today |
|---|---|---|---|
| TG | ✅ | ✅ | ✅ `sendChatAction` |
| DC | ✅ | ✅ | ◐ as TG |
| SL | ✅ "is thinking…" assistant status | ✅ + typing reaction | — |
| WA | ✅ | ✅ | — |
| SG | ✅ (every 8 s) | ✅ | — |
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
| SL | ✅ Block Kit | ✅ | ✅ Block Kit Yes / No buttons carrying the fingerprint (and the per-occurrence nonce for owner DM commands); a press arrives on the Socket Mode connection and is taken once. A command Slack would draw differently (`<`, `>`, `&`, backtick) gets only No |
| WA | — typed (never polls) | ✅ 👍/👎 reactions | — typed |
| SG | — | ✅ approval reactions | — typed |
| IM | ? | ? | — typed |
| MX | ✅ reactions, limited to the requester | ✅ | — typed |
| EM, SMS | — | — | — typed |

### Voice notes in (transcribed) and out (spoken replies)
| | H in / out | O in / out | B today |
|---|---|---|---|
| TG | ✅ / ✅ voice bubble | ✅ / ? | ✅ in; ◐ out: `sendAudio` (an audio file, not a voice bubble) |
| DC | ✅ / ✅ (voice channels) | ✅ / ✅ | ✅ in; — out |
| SL | ✅ / ? | ? | — |
| WA | ✅ / ✅ | ✅ / ◐ calls, experimental | ✅ in; — out |
| SG | ✅ / ✅ as attachment | ? | — |
| IM | ? / ✅ | ? | — |
| MX | ✅ / ✅ | ✅ / ? | — |
| EM, SMS | — | — | — |

### Photos, files and documents, in and out
| | H | O | B today (in / out) |
|---|---|---|---|
| TG | ✅ | ✅ | ✅ / ✅ `sendDocument` (photos go out as documents) |
| DC | ✅ | ✅ | ✅ / ✅ |
| SL | ✅ | ✅ | — / ✅ |
| WA | ✅ | ✅ | — / — |
| SG | ✅ (100 MB) | ✅ | — / — |
| IM | ✅ | ✅ | — / — |
| MX | ✅ | ? | — / — |
| EM | ✅ attachments | ? | — / — |
| SMS | — | ◐ MMS | — / — |

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
| WA | — | ✅ | — |
| SG | ✅ | ✅ | — |
| IM | ✅ tapbacks | ✅ | — |
| MX | ✅ | ✅ | ✅ `m.reaction` on the exact inbound event; own previous status is redacted before replacement (stand-in proof) |
| EM, SMS | — | — | — |

### Slash commands and menus
| | H | O | B today |
|---|---|---|---|
| TG | ✅ `setMyCommands` menu, inline picker | ✅ menu plus custom entries | ◐ typed commands only (switch ships off); no `setMyCommands` menu |
| DC | ✅ native slash commands | ✅ | ◐ typed only |
| SL | ✅ native slash commands, `!cmd` in threads | ✅ | ◐ typed only |
| Others | ✅ typed | ✅ typed | ◐ typed (switch ships off) |

### Long-message splitting
| | H | O | B today |
|---|---|---|---|
| All | ✅ numbered parts; fences kept valid | ✅ paragraph, then length; fences reopened | ✅ split at paragraph breaks, code blocks never left open |

### Reply-to / quote
| | H | O | B today |
|---|---|---|---|
| TG | ✅ | ✅ native quote excerpts | ✅ `reply_parameters` |
| DC | ✅ (`first` / `all`) | ✅ | ✅ `message_reference` |
| SL | ✅ threads | ✅ | ✅ thread |
| WA | ✅ quoted context and media | ✅ quote mode | ✅ `context.message_id` |
| SG | ✅ native quote | ? | — |
| IM | ? | ✅ `reply_to_guid` | — |
| MX | ? | ✅ | — |
| EM | ✅ | ? | ✅ |

### Per-chat model and Trunk
| | H | O | B today |
|---|---|---|---|
| All | ✅ `/model` (saved per chat); per-channel prompt and model overrides | ✅ agent bindings per channel or account | ◐ `/model` in chat (commands switch); a chat linked to a Trunk's conversation. No picker menu |

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
| `/stop` | ✅ | ✅ | ◐ the commands switch ships off (it reaches Branch from outside) |
| Reset | ✅ `/new`, `/reset` | ✅ | ◐ `/new` (same switch) |
| Usage | ✅ `/usage`, `/insights` | ✅ | ◐ `/usage` and a per-reply footer (same switch) |

### Live screen and remote control from a chat (owner request, 2026-09-27)
| | What the platform allows | H | O | B today |
|---|---|---|---|---|
| TG | `editMessageMedia` replaces a screenshot in place; inline keyboards; Mini App (WebApp) with signed `initData` | — | ◐ `/dashboard` Mini App (Tailscale only, owner `allowFrom`, signed `initData` checked) | — the live screen refuses every door on purpose (`liveScreenDoorRefusal`) |
| DC | edit a message's attachments; buttons | — | — | — |
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
| bluesky | yes | — | — | — | — | — | — | — | — | 1000 |
| deltachat | yes | — | — | — | — | — | — | — | — | 3500 |
| discord | yes | yes | yes | yes | yes | — | yes | yes | yes | 2000 |
| discourse | yes | — | — | — | — | — | — | — | — | 3500 |
| email | yes | — | — | — | — | — | — | — | — | 3500 |
| flock | yes | — | — | — | — | — | — | — | — | 3500 |
| gotify | yes | — | — | — | — | — | — | — | — | 3500 |
| guilded | yes | — | — | — | — | — | — | — | — | 3500 |
| homeassistant | yes | — | — | — | — | — | — | — | — | 3500 |
| imessage | yes | — | — | — | — | — | — | — | — | 3000 |
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
| signal-cli | yes | — | — | — | — | — | — | — | — | 2000 |
| simplex | yes | — | — | — | — | — | — | — | — | 3500 |
| slack | yes | yes | — | yes | — | — | yes | — | — | 3000 |
| synology-chat | yes | — | — | — | — | — | — | — | — | 2000 |
| teams-bot | yes | — | — | — | — | — | — | — | — | 3500 |
| telegram | yes | yes | yes | yes | yes | yes | yes | yes | yes | default |
| threema | yes | — | — | — | — | — | — | — | — | 3500 |
| twilio-sms | yes | — | — | — | — | — | — | — | — | 1600 |
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

1. **This matrix.**
2. **Telegram, the live progress message.**
   - Hermes lines from `liveSteps()`.
   - Commands as `pre` "shell" blocks and paths as inline code, sent as message entities.
   - ×N folding and a summary line at the end.
   - `retry_after` honoured, and a slower rate in groups.
   - Direct chats with a paired or allowed sender only.
   - A "Show steps in chats" switch that ships on.
3. **A channel-agnostic renderer with per-platform adapters.**
   - Discord, Slack and Matrix edit in place, with fences.
   - WhatsApp, Signal, iMessage, email and SMS get one compact summary.
4. **The rest of the matrix, platform by platform:**
   - typing, reactions and buttons wherever the platform has them;
   - voice bubbles out;
   - files in and out;
   - threads;
   - a command menu;
   - quote-replies;
   - `/sethome`.
5. **Live screen and remote control from a chat** (security tier), under the rules above.
