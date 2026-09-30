# What Branch actually does

This page describes the product as of **0.18.0**, in the words the screens use, organised the way the
window is organised (`docs/places.md`). It replaces the old acceptance-audit table, which had not been
touched since the 169-row research checklist was written and no longer described anything real.

Two rules for reading it:

- **Features ship on.** Every feature has a three-way switch — off, on, or loaded only when the work
  calls for it — and arrives working ("when needed" or on), so nobody has to spend an afternoon in
  Settings first. What stays off until you say so is only what would spend money, send something out
  of this computer by itself, delete something, use the microphone or camera, use heavy CPU or disk, or
  loosen approvals and safety. Where something is off by default it says why.
- **Where a thing has only been proved against a stand-in**, it says so in the same sentence. A page
  that oversells is a support ticket later.

The machine-readable checklist in [features.json](features.json) is the original research audit. Every
row that was not already implemented was checked again on 2026-09-22 against the code and the exact
test titles it names: 117 implemented, 36 partial, 1 external, 15 missing. A partial row says in
`remaining` what is still missing. Settings, their exact names and their defaults are in
[configuration.md](configuration.md).

## Conversation — the work happening now

Talking to it by typing, by holding the Talk button, or by saying a word that starts a turn (off; on a
Mac it needs a recording program you already have). Answers read back aloud, offline where the system
has voices. Attachments: images, audio, video and documents, with pictures described once and then
searchable. A switch between "just do it" and "show me the plan first", with numbered steps in plain
words and nothing that changes anything happening until you say yes. Goal mode, rewinding files and
the conversation to an earlier message, and editing a message. Saying something to a task already
working, in a marker the assistant is told is the only trusted one. Side-by-side conversations, a
temporary conversation that leaves no trace, and branching a conversation from an earlier point. A
live meter of what the round is costing. Forty-four themes, light or dark, in two languages, down to
400 px.

## Inbox — what needs a decision, and the record

Approvals waiting for a yes, with the card naming what will be touched, on which machine, and whether
it changes anything. Suggested memory changes, each with the reason it was noticed. Finished tasks
from the last week with Look inside and Open the conversation. The whole record: every task, reports,
comparing two runs, the event log, and a tamper-evident chain that shows if the record has been cut or
rebuilt. Watching a finished task again, step by step. A proof report that says whether a build got
better and what stopped working.

## Automations — work that runs without being asked

Timed tasks, a waiting line, a heartbeat, and triggers from a webhook, a chat message, a USB device or
a program finishing. Saved procedures and flows as a proper graph: branches, loops with a limit, steps
that fan out over a list and gather again, and a flow inside a flow. State is written down after every
box, so a flow that stops at the ninth step carries on from there; a box left half-run is asked about
rather than repeated. Flow time travel, checked procedures, a shared board, widgets and a focus view.
A saved flow can be used as a tool. Suggested automations, standing orders and self-starting
procedures, all off. Quiet background jobs — a check-in, gated schedules, news-only checks and health.
A repeating schedule that fails moves to its next turn, counts failures and pauses after three, saying
why.

## Library — what it knows and what it made

Memory in blocks, with a count of what is kept, a timeline, search by meaning, lessons it drew, chat
preferences, an expiry and a read-back before memory is used. Nothing is remembered without you.
Documents and knowledge bases with summaries and citations, renaming, merging, splitting, export and a
light map of how things connect. Writing Word, Excel and PowerPoint files on this computer with no
extra software, each checked by opening it in the real program. Pictures, files and reports the
assistant made. Bringing chats and memory over from another assistant. Pruning on a schedule that
exports before it deletes.

*Proved against stand-ins only:* meaning search has seen a fake embedder, and the Mem0 and Honcho
bridges have seen fake servers.

## Customize — what it can do and who can reach it

Skills, installed and removed with a written account, read and written as Agent Skills folders, with a
scan of anything risky. Specialists. Plugins and add-ons in four formats, each walled, with a malware
check. MCP in both directions: servers the assistant uses, and other tools using Branch. Saved prompts
in groups and your own commands on every surface. Long-lived named assistants with rooms, messages,
routines and teaching.

**Chat apps.** Fifty-five services, counted from the code, every one off. Among them: Telegram,
Discord, Slack, Matrix, WhatsApp, IRC, Twitch, Gotify, iMessage, Bluesky, Reddit, Discourse, X direct messages, Twist, Mastodon, Delta
Chat, Keybase, MQTT, Nostr, SimpleX, XMPP, VK, QQ, Guilded, Revolt, Mumble, Teams, Webex, Synology
Chat, Zalo, Flock, Pumble, Nextcloud Talk, SMS, ntfy, Pushover, Threema and Home Assistant. One command
sets any of them up. Branch can see and steer a running task from the chat, and passes on typing, edits
and buttons only where the service really has them.

**What a chat may do is deliberately small.** A task started by a chat message holds four permissions:
asking you something, reading files, reading memory, reading the web. Nothing that can change anything,
including permissions added later. More is granted only by a line you write naming the app, the person
and what they may also do, behind a switch that ships off; your own devices and commands on any
computer can never be in such a line. A chat can approve a change only if you tick approvals on that
one line, which also ships off.

**Devices.** Another computer or a phone paired as a device, with a switch per ability — camera,
screen, microphone, running something — each asked about every time. A clean environment with none of
your keys, its own safe folders and a private line. Chat senders are refused at the device door.
Pairing another computer with its key is still command-line only; there is no card for it, and the
phone app has no pairing screen.

## Execution — what it can run, and how tightly

Editing files and running commands, web search, fetching and crawling a page, a browser it drives
itself with page notes, and a ranked map of a repository inside a token budget. A real box where the
computer has one — Docker, WSL or Windows Sandbox — and a wall around programs on macOS and Linux with
keys kept at the network edge; a backend you do not have refuses in plain words and names what to
install. Working on another computer over SSH, host names from your own configuration only, an unknown
host refused outright. Scripts checked for forbidden calls before anything starts, including decoders,
disguises and hidden marks. File changes get a checkpoint you can undo. A shell kept open across tasks,
held to the same rules. Tool scripts, WebAssembly add-ons, one-time codes, an emergency stop, a
progress check and a repair for a damaged history. Diagnosing, fixing and re-running a failed command,
behind its own switch and held to the caller's own permissions. Lockdown refuses commands outright
rather than asking about them.

## Models

Hosted providers and models on this computer, the local ones downloadable in one click. API keys and
the OAuth routes each maker actually allows. Which model does what, routing, fallbacks and live
switching with a visible notice. Several accounts per connection, with key rotation and owner-switched
sign-ins. Caching, cheaper routes for small side questions and a clearer cost per task — a mixture is
priced at its dearest member, never its cheapest. A Terms line for every provider in the picker.

*Not proved:* the learning core has never run against a real model, so there is no head-to-head
scoreboard against Hermes.

## Settings, and the app itself

Named pages, opened over whatever you were doing and closed on Escape, with descriptions, scope chips,
presets, reset, one settings file and a map of where each setting lives. Any setting can be **pinned**,
so a household person sees it but cannot change it; pinning is the owner's alone and no preset or
imported file can undo it. Comfort settings: keyboard shortcuts, vim keys, a status line,
notifications, voice keys, browser care, a proxy and your own certificates, terminal controls. Filling
a saved sign-in from the password manager you already use, by the website the page is actually on,
never showing, printing, logging or telling the model the value. People on this computer, signing in
from another device, groups and sharing. A usage report and task counters. Short-lived keys that expire
and can be revoked. Traces and logs exported on your terms. A security self-check with repairs.

**Runs on Windows, macOS and Linux.** Starting with the computer, updating itself silently — tried on
a copy first, watched after the swap, and rolled back if it will not start — keeping the previous
version, and `branch doctor --fix` giving advice that matches the machine. A no-questions installer for
each system. The whole assistant runs with no window at all for a scripted job, and a gateway keeps
Branch's address open and restarts the engine. A browser dashboard at `/dashboard`. Branch on iPhone
and Android as shells around the same window. A Go client, React hooks, an app-builder kit over MCP and
flows as YAML. Plain-language page tests you can accept and run as owner suites.

**Node.js 24.14.0 or newer is required** (on the Node 25 line, 25.4.0 or newer), because the proxy
setting works by handing the proxy to Node and older Nodes have no way to be told. On an older Node the
command line says so once and carries on; everything except the proxy still works.

*Never built against the real thing:* the Docker, Nix and Termux packaging files, and the video
services.
