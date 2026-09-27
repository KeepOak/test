# SHOWCASE17: where every engine capability now lives (pass 17, part B)

Source: `../research/GAP-MATRIX.md` §4 (ENGINE list by home) and §5 (Branch-only). Each bullet there is one row here.

- **Status.** "Added" means new in `patch17b.js`. "Upgraded" means a v16 control that only showed a note now opens the real thing. "Already shown" means v16 already had it; the row says where.
- **Where.** The home in backticks is machine-readable, and `check17b.cjs` reads it.
  - `settings:<page>[#tab]@<level>`, where level is 0 Regular, 1 Advanced, 2 Technical.
  - `<place>:<tab>[#view][@level]`.
  - `chat:<id>` is the message box; `pane:<id>:activity` is the side panel.
- **data-act.** This is the control's action. `demob17:<key>` opens the shared example dialog for that key.
- **Controls inside a dialog.** They are listed after `→`.

## §4 ENGINE list

| # | Capability | Status | Where it lives | data-act |
|---|---|---|---|---|
| 1 | Steer or redirect a running turn | Added | Message box chip "Steer Scout" while a task works `chat:scout` | `steerb17` → `steerpickb17`, `steergob17` |
| 2 | Sub-agent spawning | Added | Side panel › Activity › Helpers on this task `pane:scout:activity` | `subb17` |
| 3 | Sub-agent coordination primitives | Already shown | Customize › Specialists › How Trunks work together | `pat15` |
| 4 | Test-driven refinement (troubleshoot loop) | Added | Settings › Computer & browser › Where scripts run, more `settings:computer@1` | `demob17:troubleshoot` |
| 5 | Tool/instruction preservation readout | Added | Side panel › Activity › Travels with every round `pane:scout:activity` | `keptb17` |
| 6 | Cryptographic tool receipts (verify per run) | Added | Inbox › History › Signed receipts › See the chain `inbox:history` | `chainb17` → `rcptb17`, `chaintamperb17` |
| 7 | Chat-app threads with progress cards; chat approvals land in the Inbox | Added | Inbox › Needs you › "From Telegram" approval with its progress bar, counted in the Inbox badge `inbox:needs` | `xdo:tg-b17` (the Inbox’s own Allow / Don’t) |
| 8 | Standing orders | Added + Upgraded | Automations › Scheduled › Standing orders and loops `automations:scheduled`; Settings › Advanced › Standing orders now opens it | `ordersb17` → `orderaddb17`; `orderb17`, `loopb17` |
| 9 | Task templates / blueprints | Already shown | Automations › Scheduled › Ideas; Customize › Trunks › Start from a job | `ideas15`, `tmpl` |
| 10 | Domain workflow agents: watches, leads, forecasts | Added | Automations › Scheduled › Running on its own, more `automations:scheduled@1` | `demob17:watches`, `demob17:leads`, `demob17:forecast` |
| 11 | Cross-device task persistence | Already shown | `/handoff` in the message box; Customize › Everywhere | `surface` |
| 12 | Workflows as code / typed pipelines | Added | Settings › Developer › Build on Branch › Procedures as text `settings:developer@2` | `demob17:flowyaml` |
| 13 | Orchestration with approval gates / SOP engine | Already shown | Automations › Procedures › Open (the "Ask me" step in the flow editor); SOP.md in Instructions | `flow` |
| 14 | Outbound webhooks on events | Added | Automations › Triggers › Hooks `automations:triggers@1` | `demob17:outhook` |
| 15 | Device and peripheral triggers (USB, folder, MQTT) | Already shown | Settings › Advanced › Automations "Start when a USB device is plugged in"; Triggers "File new receipts" (folder); MQTT in Channels | `seg` |
| 16 | Lifecycle hooks | Added | Automations › Triggers › Hooks `automations:triggers@1` | `demob17:hooks` |
| 17 | Turn-completion hooks | Added | Automations › Triggers › Hooks `automations:triggers@1` | `demob17:turnhook` |
| 18 | Event subscriptions for programs | Added | Settings › Developer › Build on Branch `settings:developer@2` | `demob17:events` |
| 19 | Workspace memory (project notes, Markdown mirror) | Added | Settings › Advanced › Memory, more `settings:advanced@1` | `demob17:wsmem` |
| 20 | Preference learning (habits) | Added | Library › Memory › How it learns `library:memory@1` | `demob17:habits` |
| 21 | Learning screen / timeline | Added | Library › Memory › How it learns `library:memory@1` | `demob17:learnlog` |
| 22 | Knowledge graph memory | Added | Library › Documents › Map › Ask the map `library:documents#map` | `kgb17` |
| 23 | Context engine / retrieval pipeline | Already shown | Settings › Advanced › Library, more "Search documents by meaning"; Memory "Match by meaning" | `seg` |
| 24 | Skill curator (reflection, retiring, governance) | Added | Customize › Tools › Skills › Keeping skills in shape `customize:tools#skills@1` | `demob17:curator` |
| 25 | Skill registry / marketplace with trust checks | Already shown | Customize › Tools › Skills › Add a skill › From the skill library ("checked"); Advanced "Only signed skill packages" | `tool-add` |
| 26 | Extensions from git or a local path | Already shown | Customize › Tools › Skills › Add a skill › From GitHub / From a file | `tool-add` |
| 27 | Cross-harness skill compatibility | Added | Customize › Tools › Skills › Keeping skills in shape `customize:tools#skills@1` | `demob17:harness` |
| 28 | Skill quality checks / lint | Added | Customize › Tools › Skills › Keeping skills in shape `customize:tools#skills@1` | `demob17:lint` |
| 29 | Extension evals (skill benchmark) | Already shown | Customize › Tools › Skills › suggested skill › "Practice run on the last 3 tasks" | `rev` |
| 30 | Custom browser action handlers (site skills) | Upgraded | Settings › Computer & browser › The browser, more › Site skills `settings:computer@1` | `siteb17` → `siteforgetb17` |
| 31 | Shared brain configs / whole-agent export | Added + Upgraded | Settings › Data & usage › Moving in and out `settings:usage@0`; Advanced › Share a Trunk now opens it | `exportb17` → `exportgob17` |
| 32 | Drive other vendors' agent CLIs as workers | Added | Customize › Specialists › Other coding agents `customize:specialists@1` | `demob17:handoffcli` |
| 33 | Plugins (code and bundle) | Already shown | Customize › Tools › Plugins › Add a plugin | `plug-add` |
| 34 | Plugin validation | Added | Customize › Tools › Plugins › Checking plugins `customize:tools#plugins@1` | `demob17:plugcheck` |
| 35 | Custom model adapters (provider plugins) | Added | Settings › Models › Connections, technical `settings:models#connections@2` | `demob17:provplug` |
| 36 | Example extensions | Added | Customize › Tools › Plugins › Checking plugins `customize:tools#plugins@1` | `demob17:examples` |
| 37 | MCP server sign-in (OAuth) | Already shown | Customize › Tools › Connectors ("signed in with GitHub / Microsoft / Google") | `t9-sel` |
| 38 | MCP gateway, "try a server" | Already shown | Customize › Tools › Connectors › Add a server › Test it | `mcp-test` |
| 39 | MCP server status / preflight | Already shown | Customize › Tools › Connectors › Postgres "Not running · port refused" | `t9-sel` |
| 40 | Agent exposed as an MCP server | Added | Customize › Tools › Connectors › Branch for other apps `customize:tools#mcp@1` | `demob17:asmcp` |
| 41 | Agent Client Protocol for editors | Already shown | Customize › Tools › Agents › Your code editor (ACP) | `t9-sel` |
| 42 | One API over many models (OpenAI-compatible) | Added | Customize › Tools › Connectors › Branch for other apps `customize:tools#mcp@1` | `demob17:oaiapi` |
| 43 | Agent manifest (A2A card) | Added | Customize › Tools › Connectors › Branch for other apps `customize:tools#mcp@1` | `demob17:a2acard` |
| 44 | Channel-native features; iMessage, WhatsApp, SMS; work-chat rooms; email-to-task | Already shown | Customize › Channels (55-service catalogue: iMessage, WhatsApp, Text messages, Feishu, DingTalk, WeCom, Teams, Google Chat, Email) | `ch-open` |
| 45 | Slack / chat automation, broadcast, digest; relay | Added (relay already shown) | Settings › Gateway › Chat apps, in depth `settings:gateway@1`; relay in Gateway › Chat apps, even more | `demob17:broadcast` |
| 46 | Telegram depth | Added (topics, media, receipts already shown in the Telegram dialog) | Settings › Gateway › Chat apps, in depth `settings:gateway@1` | `demob17:tgdepth` |
| 47 | Delivery ledger with retry; send files; voice-note transcription | Added (send files already shown) | Settings › Gateway › Chat apps, in depth `settings:gateway@1` | `demob17:delivery`, `demob17:voicenote` |
| 48 | Pluggable chat platforms; auto-reply router | Added (catalogue already shown) | Settings › Gateway › Chat apps, in depth `settings:gateway@1` | `demob17:router` |
| 49 | Mobile apps, biometric auth, OS secret storage | Already shown | Customize › Channels › Your phone › Pair a phone; Customize › Everywhere | `pair` |
| 50 | Subscription / OAuth provider sign-in | Already shown | Settings › Models › Connections › "Sign in to Gemini / OpenRouter / GitHub Copilot" | `signin` |
| 51 | Fallback chains / failover | Already shown | Settings › Accounts › When one runs out | `acct-up` |
| 52 | Side decision model / cheap router | Already shown | Settings › Models › Models for smaller jobs › "Pick the model per task" | `seg` |
| 53 | Calibrated typed judgements and spec validation | Added | Settings › Models › Mixtures and savings `settings:models@1` | `demob17:jev` |
| 54 | Prompt caching and cache warming | Already shown | Settings › Models › Per connection › "Keep Claude's cache warm" | `seg` |
| 55 | Retired-model fallback and transient retry (readout) | Added | Settings › Models › Connections, technical `settings:models#connections@2` | `demob17:retired` |
| 56 | Critique / stress-test pass | Added (second opinion already shown) | Settings › Models › Second opinion › Second opinion, more `settings:models#second@1` | `demob17:debate` |
| 57 | Video understanding | Already shown | Settings › Advanced › Tools and skills › "Video tools" | `seg` |
| 58 | FFmpeg and yt-dlp program paths | Added | Settings › Models › Media › Media, technical `settings:models#media@2` | `demob17:mediapaths` |
| 59 | Text-to-speech | Already shown | Settings › Voice › Speaking back | `seg` |
| 60 | Browser automation | Already shown | Settings › Computer & browser › The browser; Technical "Browser profile" | `seg` |
| 61 | Local-browser operator and browser extension | Already shown | Settings › Computer & browser › "Which browser: Your Chrome"; "Page notes and Send to Branch" | `seg` |
| 62 | Browser and video annotations (page notes) | Already shown | Settings › Computer & browser › The browser, more | `seg` |
| 63 | Full computer use | Already shown | Settings › Computer & browser › "See the screen and use the mouse"; Take over in the chat | `takeover` |
| 64 | Screenshot Q&A and accessibility trees | Already shown | Settings › Computer & browser › "Work in apps in the background" | `seg` |
| 65 | Code execution | Already shown | Settings › Computer & browser › "Where scripts run" | `seg` |
| 66 | Background process tool | Added | Settings › Computer & browser › Where scripts run, more `settings:computer@1` | `demob17:bgproc` |
| 67 | Sandboxing options | Already shown | Settings › Permissions › Isolation | `seg` |
| 68 | WASM metered sandbox | Already shown | Settings › Developer › "Tool scripts and WebAssembly" | `seg` |
| 69 | Network policy (firewall) | Added | Settings › Permissions › Test and explain › What Trunks may reach, in sentences `settings:permissions@1` | `fwb17` → `fwtestb17` |
| 70 | Egress proxy with credential broker | Already shown | Settings › Permissions › Isolation › "Add sign-ins from outside the sandbox" | `seg` |
| 71 | Work on a remote machine (SSH) | Already shown | Settings › Computer & browser › Your other computers (taofik-ai); Permissions "Pin SSH hosts" | `comp-chip` |
| 72 | File transfer and geolocation | Already shown | Settings › Computer & browser › Phones lent to Branch (camera, location) | `lend15` |
| 73 | Personal-data connections (device lending) | Already shown | Settings › Computer & browser › Phones lent to Branch | `lend15` |
| 74 | Remote control from any device (pairing) | Already shown | Team › Signing in; Customize › Channels › Pair a phone | `pair` |
| 75 | Authenticated ingress for teams | Already shown | Settings › Advanced › Automations › "Reach webhooks from outside" (cloudflared, ngrok, Tailscale) | `seg` |
| 76 | Remote dashboard sign-in | Already shown | Team › Signing in (PIN, passkey, identity service) | `seg` |
| 77 | Fleet management / node hosts | Already shown | Customize › Specialists fleet line; Settings › Computer & browser › Your other computers | `comp-add` |
| 78 | Password-blind vault autofill | Already shown | Settings › Saved sign-ins (Bitwarden) | `toast` |
| 79 | Credential vault integration | Added | Settings › Saved sign-ins › Where passwords come from `settings:secrets@1` | `vaultb17` |
| 80 | Secrets separate from behaviour config (locker) | Added | Settings › Saved sign-ins › Where passwords come from `settings:secrets@1` | `demob17:locker` |
| 81 | Key status without leaking (secrets audit) | Added | Settings › Saved sign-ins › Where passwords come from `settings:secrets@1` | `demob17:keys` |
| 82 | OAuth token hygiene | Added | Settings › Saved sign-ins › Where passwords come from `settings:secrets@1` | `demob17:tokens` |
| 83 | Safety classifier (second look before approval) | Added | Settings › Permissions › Test and explain › "A second look before approvals" (switch) | switch (`data-sw`) |
| 84 | Deterministic policy engine (ordered rules, tester) | Added (rules already shown) | Settings › Permissions › Test and explain › Test a rule `settings:permissions@1` | `ruletestb17` → `rulepickb17`, `rulerunb17` |
| 85 | Project trust at startup (trusted folders) | Added | Settings › Permissions › Test and explain `settings:permissions@1` | `demob17:trust` |
| 86 | Quotas, rate limits, concurrency caps | Already shown | Settings › Permissions "Messages per conversation per hour"; Models "Sub-tasks at once"; Computer "At once" | `seg` |
| 87 | Secret-leak screening | Added | Settings › Permissions › Test and explain › "Hold back keys found in answers" (switch) | switch (`data-sw`) |
| 88 | Secrets kept out of transcripts (automatic) | Added | Settings › Permissions › Guards that are always on `settings:permissions@2` | `demob17:leakguard` |
| 89 | Passkeys / OIDC sign-in | Already shown | Team › Signing in › "How they prove it's them" | `seg` |
| 90 | Durable per-person profiles from an identity provider | Already shown | Team › Signing in › Accounts linked by email | `toast` |
| 91 | Admin-locked managed settings (pinned) | Already shown | Settings › Permissions › Pinned settings | `pin-add8` |
| 92 | Operator scopes (short-lived keys) | Added | Settings › Developer › Build on Branch `settings:developer@2` | `demob17:scopes` |
| 93 | Session share (read-only links) | Already shown | Team › Shared › "Lisbon plan (copy)" | `toast` |
| 94 | Native installers and one-command uninstall | Already shown | Settings › Updates & about › Remove Branch | `install` |
| 95 | Spend caps per provider or model | Added | Settings › Data & usage › Money and keeping, more `settings:usage@1` | `capsb17` → `capssaveb17` |
| 96 | Accurate per-mode cost metering | Already shown | Settings › Data & usage (estimated from each model's price) | `rep15` |
| 97 | Remaining-balance check | Added | Settings › Data & usage › Money and keeping, more `settings:usage@1` | `demob17:balance` |
| 98 | Import from other agents (move-in) | Added | Settings › Data & usage › Moving in and out `settings:usage@0` | `moveinb17` → `moveinpickb17`, `moveingob17` |
| 99 | Backup and archive | Added | Settings › Data & usage › Money and keeping, more `settings:usage@1` | `demob17:backup` |
| 100 | Tracing and telemetry export | Added (OpenTelemetry switch already shown) | Settings › Developer › Build on Branch `settings:developer@2` | `demob17:tracing` |
| 101 | QA scenario library | Already shown | Settings › Data & usage › Test the model you use | `eval-run` |
| 102 | SDKs, OpenAPI contract, server mode | Added | Settings › Developer › Build on Branch `settings:developer@2` | `demob17:sdk` |
| 103 | Headless / structured CLI, admin CLI | Added | Settings › Developer › Build on Branch `settings:developer@2` | `demob17:cli` |
| 104 | Terminal UI | Already shown | Customize › Everywhere › Terminal | `surface` |
| 105 | API errors with fix hints; tool-call repair | Added (repair already shown in General) | Settings › Advanced › Health `settings:advanced@2` | `demob17:fixhints` |
| 106 | Tool output compression; deferred tool loading; structured outputs | Already shown | Settings › Developer "Load tools only when needed"; Models "Largest tool answer kept whole" | `seg` |
| 107 | Binary attestation (update provenance) | Already shown | Settings › Permissions › Isolation › "Verify each release" | `seg` |
| 108 | Web fetch, X search, deep research | Added (X search already shown) | Settings › Advanced › What it can do (switches) `settings:advanced@1` | switch (`data-sw`), `demob17:claims` |
| 109 | LSP, GitHub, GitLab | Added (LSP and GitHub already shown) | Settings › Advanced › What it can do › GitLab (switch); Developer › Use language servers | switch (`data-sw`) |
| 110 | Smart-home and personal integrations | Added | Settings › Advanced › What it can do › Smart home (switch) | switch (`data-sw`) |
| 111 | Single-writer session DB (automatic) | Added | Settings › Advanced › Health `settings:advanced@2` | `demob17:health` |
| 112 | Single-instance guard (automatic) | Added | Settings › Advanced › Health (same readout) `settings:advanced@2` | `demob17:health` |

## §5 Branch-only

| # | Capability | Status | Where it lives | data-act |
|---|---|---|---|---|
| 113 | Adapt a stopped task | Added | Inbox › Needs you › "Ledger stopped" card `inbox:needs` | `adaptb17` → `adaptpickb17`, `adaptgob17`, `adaptnob17` |
| 114 | Deferred and handed-over work | Added | Inbox › Later (new tab) `inbox:later` | `laterb17` |
| 115 | Orchestration extras: auto-plan, milestone notes, "stuck" | Added (plan already shown) | Side panel › Activity › "It looks stuck" `pane:scout:activity` | `stuckb17` |
| 116 | Specialists with styles, evaluation, promotion, rollback | Upgraded | Customize › Specialists › each row's Edit now opens the card `customize:specialists` | `specb17` → `specstyleb17`, `specevalb17`, `specverb17` |
| 117 | Loop guard and empty-answer-as-failure | Added | Settings › Permissions › Guards that are always on `settings:permissions@2` | `demob17:loopguard` |
| 118 | Goal undo | Added (Pause, Resume and Stop already shown) | Supplier quotes room › goal card › Undo `chat:room` | `goalundob17` → `goalundogob17` |
| 119 | Account pools and rotation | Already shown | Settings › Models › Connections (3 accounts per service, "Answers first / Next in line"); Settings › Accounts (order, select several) | `acct-up`, `acsel15` |
| 120 | One-button local model sized to the machine | Already shown | Settings › On this computer (hardware readout, "Runs great", Install); Models › On this computer › "Get with one click" | `lm-get`, `download` |
| 121 | Local routing: private notes stay here | Added | Settings › Models › Mixtures and savings `settings:models@1` | `demob17:localroute` |
| 122 | Terms line per provider | Added | Settings › Accounts › Terms `settings:accounts@1` | `demob17:terms` |
| 123 | Model arena (blind A/B with a vote) | Upgraded | Settings › Models › Compare models › Open the arena `settings:models@1` | `arenab17` → `arenavoteb17`, `arenanextb17` |
| 124 | Compare models side by side | Upgraded | Settings › Models › Compare models › Test suites › See history `settings:models@1` | `compareb17` → `cmpsuiteb17`, `cmpsideb17`, `cmprunb17` |
| 125 | Model mixtures and fewer-rounds savings | Added | Settings › Models › Mixtures and savings › See the savings `settings:models@1` | `savingsb17` → `mixb17` |
| 126 | Shell inside a Windows job object | Added | Settings › Computer & browser › Limits, technical `settings:computer@2` | `demob17:jobobj` |
| 127 | Byte-identical document edits; compare two documents | Added | Library › Documents › Work with documents › Compare or edit exactly `library:documents` | `doccmpb17` → `docmodeb17`, `docsaveb17` |
| 128 | Read-only SQL over CSV and spreadsheets, with charts | Added | Library › Documents › Work with documents › Ask a spreadsheet `library:documents` | `sqlb17` → `sqlfileb17`, `sqlqb17`, `sqlrunb17` |
| 129 | Save as report | Added | Ask a spreadsheet › Save as a report `library:documents` | `sqlb17` → `sqlsaveb17` |
| 130 | Tool playground | Upgraded | Settings › Developer › Tools, technical › Playground `settings:developer@2` | `playb17` → `playtoolb17`, `playrunb17` |
| 131 | Labels on conversations, procedures, documents | Added | Library › Documents › Work with documents › Labels `library:documents@1` | `labelb17` |
| 132 | Checkable claims with numbered sources | Added | Settings › Advanced › What it can do `settings:advanced@1` | `demob17:claims` |
| 133 | Browser profiles that stay signed in | Added | Settings › Computer & browser › Where scripts run, more `settings:computer@1` | `demob17:profiles` |
| 134 | Shared Linux desktop with take-over and hand-back | Already shown | Scout's conversation › computer card › Take over / Hand it back | `takeover`, `handback` |
| 135 | Watch a screen region | Added | Settings › Computer & browser › Where scripts run, more `settings:computer@1` | `demob17:screenwatch` |
| 136 | Trunks on other computers (roster, messaging) | Already shown | Customize › Tools › Agents › Archivist (Branch on taofik-ai) | `t9-sel` |
| 137 | Per-capability device lending, per conversation | Added | Settings › Computer & browser › Where scripts run, more `settings:computer@1` | `demob17:devpick` |
| 138 | Pair from network discovery | Already shown | Settings › Developer › System › "Find Branch on other computers nearby" | `seg` |
| 139 | Memory proposals | Already shown | "Remember this?" card in the chat; Library › Memory | `forget` |
| 140 | Exact fact versions with restore | Added | Library › Memory › How it learns `library:memory@1` | `demob17:factver` |
| 141 | Tidy memory | Already shown | Library › Memory › Tidy up | `tidy15` |
| 142 | Archive and restore facts | Already shown | Library › Memory › ⋯ › Archived facts | `memarch15` |
| 143 | Memory export and import | Added (export already shown) | Library › Memory › How it learns › Bring memories in `library:memory@1` | `demob17:memimport` |
| 144 | Memory checkpoints | Added | Library › Memory › How it learns `library:memory@1` | `demob17:memckpt` |
| 145 | Forget what one conversation taught | Added | Library › Memory › How it learns `library:memory@1` | `demob17:forgetconv` |
| 146 | Nightly meaning-based consolidation | Added | Settings › Advanced › Memory, more `settings:advanced@1` | `demob17:consolidate` |
| 147 | Memory in Git | Already shown | Settings › Advanced › Memory › "Keep a history in Git" | `seg` |
| 148 | Knowledge-base management | Added | Library › Documents › Managing what it reads `library:documents@1` | `demob17:kbmanage` |
| 149 | Follow-ups made whole | Added | Settings › Advanced › Memory, more `settings:advanced@1` | `demob17:followup` |
| 150 | Scratch store for pasted text | Added | Settings › Advanced › Memory, more `settings:advanced@1` | `demob17:scratch` |
| 151 | Knowledge cards from chat | Added | Settings › Advanced › Memory, more `settings:advanced@1` | `demob17:kcards` |
| 152 | Obsidian bridge | Already shown | Customize › Tools › Connectors › Add a server › Obsidian | `tool-add` |
| 153 | Understand a folder (map and tour) | Added | Library › Documents › Managing what it reads `library:documents@1` | `demob17:learnfolder` |
| 154 | Eight instruction files with one undo | Already shown | Settings › Instructions & personality | `if-open` |
| 155 | 55-service chat catalogue with a wizard per app | Already shown | Customize › Channels | `ch-open` |
| 156 | Typed commands the same everywhere | Already shown | Automations › Procedures › Your saved prompts | `prompt-use` |
| 157 | Webhook addresses per chat app, with rotation | Added | Settings › Gateway › Chat apps, in depth `settings:gateway@1` | `demob17:hookaddr` |
| 158 | Pause one chat platform; `branch send` | Already shown | Settings › Gateway › Chat apps, more; From scripts | `seg` |
| 159 | Embeddable widget | Already shown | Customize › Everywhere › A page of your own | `widget6` |
| 160 | Quit guard | Already shown | Quit while tasks run › "Quit anyway" | `quit` |
| 161 | Job gate | Already shown | Automations › Check-ins › "A check script wants your yes" | `toast` |
| 162 | Morning brief, optionally spoken | Already shown | Settings › Voice › Spoken morning brief; Automations › Weekday brief | `seg` |
| 163 | Flow time travel and fork | Already shown | Automations › Procedures › Open › time travel | `flow` |
| 164 | Automation ideas | Already shown | Automations › Scheduled › Ideas | `ideas15` |
| 165 | Autonomy readiness check and ledger | Added | Automations › Scheduled › Running on its own, more `automations:scheduled@1` | `demob17:readiness` |
| 166 | Focus view (what's busy) | Already shown | Automations › Board | `bmove15` |
| 167 | Days off and holidays for schedules | Added | Automations › Scheduled › Running on its own, more `automations:scheduled@1` | `demob17:holidays` |
| 168 | Pause all automations | Added | Automations › Scheduled › Running on its own, more `automations:scheduled@1` | `pauseallb17` |
| 169 | Skill install/remove with a written account | Added | Customize › Tools › Skills › Keeping skills in shape `customize:tools#skills@1` | `demob17:installacct` |
| 170 | Turn an OpenAPI description into tools | Already shown | Settings › Developer › Tools, technical | `toast` |
| 171 | Message filters and pipelines with valves | Added | Customize › Tools › Plugins › Checking plugins `customize:tools#plugins@1` | `demob17:valves` |
| 172 | Install requests | Already shown | Inbox › Needs you › "Install a PDF reading tool?" | `xdo` |
| 173 | Agent Protocol and an agent market | Already shown | Settings › Advanced › Trunks, more › Agent marketplace | `toast` |
| 174 | Debugger through the owner's debug adapter | Already shown | Settings › Developer › Help with code › Use a debugger | `seg` |
| 175 | `AI!` comments | Already shown | Settings › Computer & browser › Code | `seg` |
| 176 | Workspace code editor | Added | Settings › Computer & browser › Where scripts run, more `settings:computer@1` | `demob17:editor` |
| 177 | Branch changes its own code (draft PR) | Already shown | Inbox › Needs you › "Branch wants to improve itself" | `selfrev15` |
| 178 | `.branchignore` | Already shown | Settings › Computer & browser › Code, technical | `seg` |
| 179 | Exact bytes kept before every change, with restore | Already shown | Settings › Data & usage › Checkpoints | `ckpt-demo` |
| 180 | Lockdown | Already shown | Settings › Permissions › Lockdown; Overview › Controls | `lock` |
| 181 | App lock with a PIN or after a quiet period | Added | Settings › Permissions › Locks and records `settings:permissions@1` | `applockb17` |
| 182 | Emergency stop; authenticator codes | Added (codes already shown) | Settings › Permissions › Locks and records `settings:permissions@1` | `estopb17` → `estopgob17` |
| 183 | Script check before running | Added | Settings › Permissions › Guards that are always on `settings:permissions@2` | `demob17:codecheck` |
| 184 | Prompt-injection defence (automatic) | Added | Settings › Permissions › Guards that are always on `settings:permissions@2` | `demob17:injection` |
| 185 | Outbound PII hiding | Already shown | Settings › Permissions › Checks before anything runs › "Scan for personal details" | `seg` |
| 186 | Audit of every widening or narrowing, as CSV | Added | Settings › Permissions › Locks and records `settings:permissions@1` | `demob17:audit` |
| 187 | Security self-check with repairs | Already shown | Settings › Branch itself › Check and fix | `doctor` |
| 188 | OS permissions readout that opens the real pane | Already shown | Settings › Permissions › This PC / This Mac | `sys16` |
| 189 | Practice workspace of made-up files | Added | Settings › Permissions › Locks and records `settings:permissions@1` | `demob17:practice` |
| 190 | Chat-started tasks limited to four read-only permissions | Added | Settings › Permissions › Guards that are always on `settings:permissions@2` | `demob17:chatperm` |
| 191 | Household roles for adults and children, owner PIN | Already shown | Settings › People (Child role, PIN) | `p-role` |
| 192 | Signed household events and git patches | Added | Settings › People › Records `settings:people@1` | `demob17:signed` |
| 193 | Gateway change proposals | Already shown | Settings › Branch itself › Every change ("tried on a throwaway copy") | `gw-prop` |
| 194 | Change settings by talking | Added | Settings › Branch itself › Settings you can talk to `settings:self@1` | `demob17:talksettings` |
| 195 | Learning core: local suggestions | Added | Settings › Branch itself › Settings you can talk to `settings:self@1` | `demob17:learncore` |
| 196 | Reproducible studies with a journal | Added | Settings › Developer › Build on Branch `settings:developer@2` | `demob17:studies` |
| 197 | Look inside a task; compare two tasks | Already shown | Message ⋯ › Look inside; Inbox › History › "Compare it with last Friday's" | `inspect`, `compare` |
| 198 | Task recordings with a path picture | Already shown | Inbox › History › Watch again | `replay` |
| 199 | Conversation and project cost | Added (conversation cost already in the status line) | Settings › Data & usage › Money and keeping, more `settings:usage@1` | `demob17:projcost` |
| 200 | Event-loop and provider health | Added (keeping-up switch already shown) | Settings › Advanced › Health `settings:advanced@2` | `demob17:health` |
| 201 | Tool report | Added | Settings › Developer › Build on Branch `settings:developer@2` | `demob17:toolreport` |
| 202 | In-app handbook | Added | Settings › Updates & about › Help and updates, more `settings:updates@1` | `demob17:handbook` |
| 203 | Setting suggestion bar | Already shown | The "Recommended" bar on places (gateway, updates) | `rec` |
| 204 | Understandable settings: why, history, undo, put back | Added | Settings › Permissions › Test and explain › Why is this set? `settings:permissions@1` | `whyb17` → `whyputb17` |
| 205 | Never-break gateway: canary, journal, rollback | Added | Settings › Gateway › Never break `settings:gateway@1` | `nbb17` → `nbtryb17` |
| 206 | Update readiness; a Trunk fixes a failed update | Added (waiting for busy tasks already shown) | Settings › Updates & about › Help and updates, more `settings:updates@1` | `demob17:updfix` |
| 207 | Retention: prune after export | Added | Settings › Data & usage › Money and keeping, more `settings:usage@1` | `demob17:retention` |
| 208 | Restore points and held rows | Added | Settings › Data & usage › Money and keeping, more `settings:usage@1` | `demob17:held` |
| 209 | In-chat audio and video playback | Already shown | Fieldnotes conversation › recordings | `mplay15` |
| 210 | Voice approvals and a phone talk key | Added | Settings › Voice › Talking, more `settings:voice@1` | `demob17:voiceapprove` |
| 211 | Local wake word and dictation | Already shown | Settings › Voice › Listening | `seg` |
| 212 | Kept answer pages and a long-article writer | Added | Library › Documents › Managing what it reads `library:documents@1` | `demob17:pages` |
| 213 | Source sync | Added | Library › Documents › Managing what it reads `library:documents@1` | `demob17:sources` |
| 214 | App blocks, live tool surfaces, Codex app-server | Added | Settings › Developer › Build on Branch `settings:developer@2` | `demob17:surfaces` |
| 215 | Reach notes | Added | Settings › Advanced › Memory, more `settings:advanced@1` | `demob17:reachnotes` |
| 216 | Window frame switches; project boards | Added (boards already shown as Automations › Board) | Settings › Appearance › Window, technical `settings:appearance@2` | `demob17:frame` |

## Counts

| | Rows |
|---|---|
| Added (new, or new next to a part v16 already had) | 121 |
| Upgraded (a v16 control that only showed a note now opens the real thing) | 5 (plus 2 rows that are both) |
| Already shown in v16 | 90 |
| Total | 216 |

Every act ending in `b17` is clicked by `check17b.cjs`, and the check fails if one is missing from this table or from the page.
