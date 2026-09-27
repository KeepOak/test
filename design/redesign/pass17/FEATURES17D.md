# Pass 17, part D: computers, reach, automation and skills

Files: `patch17d.js` and `patch17d.css`. All of it is one block, and every class, action and state key ends in `17d`.

- **Sources:** `../CAPABILITY-LOGIC.md` §4–§5 and `../research/GAP-MATRIX.md` §3.
- **Test:** `node check17d.cjs <built file>`.
- **Example data:** all of it uses the existing cast (Taofik; Scout, Ledger, Ada, Fieldnotes; Dana; Hartwell, Oakfield).
- **Out of scope here:** flagging a reply is part C's.

Some behaviour the engine doesn't have yet. It's labelled below the way the prototype labels it: a disabled "Proposal:" choice, or an "Off until you choose" line with its reason (§1.9).

---

## 1. Always-on cloud computer per Trunk

**Where it lives**
- **Settings › Computer & browser › Computers they may use › In the cloud:**
  - with no cloud computer yet: an offer card and a "This PC goes to sleep at 11:30 PM" line;
  - once one exists: a rich card for each cloud computer.
- **Add a computer:** the "cloud" kind now reads "A cloud computer" and opens the cloud steps. KeepOak is one place it can run, not a separate kind.
- **The Trunk editor ("the Trunk's page") › Its computers tab:** that Trunk's cloud computer, or "Give Ada its own cloud computer".
- **The full-size computer view:**
  - a "Cloud · Working / Sleeping / Stopped" pill in the title;
  - a cloud card at the top of the docked conversation: where it runs, the cost so far, and Wake / Put to sleep / Stop;
  - a veil over the screen while it's asleep or stopped, with a Wake / Start button.
- **The room conversation:** an offer at the moment it helps. "This goal could run past bedtime": the room's goal needs about three more hours and this PC sleeps at 11:30 PM.

**How it behaves**
- Setup is three steps: **Where**, **Sign-ins**, **Check**.
  - **Where:** which Trunk, where it runs (KeepOak needs keepoak.com; Daytona; Modal; "A server of yours, over SSH", a disabled Proposal), region and size. A live monthly estimate: "About $6 a month" for Small, $12 for Standard and $24 for Large, if it works two hours a day. It also shows the most it could cost if it works around the clock.
  - **Sign-ins:** credentials go through the locker. The provider key is added "from Bitwarden", and Continue stays disabled until it's there. It lists which saved sign-ins the Trunk may use there ("filled by the locker, never copied onto the cloud computer"), sleep-when-idle, and a monthly cap.
  - **Check:** a summary, and the only button that spends money: "Turn on and create · about $6/mo".
- **Ships off:** nothing exists until the owner creates one. The offer card says "Off until you choose: it costs money each month and runs outside this PC."
- Once created, it becomes a `COMPUTERS` entry (`where: 'cloud'`, `kind: 'linux'`) and joins that Trunk's allow-list. It then appears everywhere computers appear: the chips, the conversation's computer menu, the stage tabs and All screens.
- From the room offer, it's created for Scout and joins the room. It starts **Working** on "the room's supplier-quotes goal", and the toast says "You can let this PC sleep."

**States**
- **Starting:** about a minute, drawn as a working pill.
- **Sleeping:** "Wakes by itself when Ada needs it."
- **Working:** shows its task, and that it keeps going while this PC sleeps.
- **Stopped:** "only its disk is billed, about $1 a month"; Remove is available.
- **Remove:** a confirmation ("Its disk is kept for 7 days"), then billing stops. It's taken out of every allow-list, and conversations using it fall back to their next computer.

## 2. Phone calls and meeting notes

**Where they live**
- **The message box's +** menu: "Phone call…" and "Join a meeting…". Each shows "off" until turned on.
- **Settings › Voice › Calls and meetings** (Advanced):
  - switches for phone calls and meeting notes;
  - "Calling from";
  - who it may call;
  - recording;
  - join from your calendar;
  - where notes go.
- **Inbox › Finished:** a result card for each call or meeting.
- **The status bar:** a live pill while a call or meeting runs. It reopens the live view.

**How they behave**
- **Both ship off**, and the first open explains why:
  - calls cost by the minute and reach people outside Branch;
  - the meeting bot listens to everyone there.
- Phone calls need the owner's Twilio number, whose key goes into the locker. Meeting notes use the connected Outlook calendar.
- **Call someone for me** (the example asks Oakfield whether 10 cases can arrive by Thursday, October 1, the room's deadline):
  - you set who calls, whom to call, the number, what to find out, and what it may agree to;
  - a **"Before it calls"** consent block: it announces it's an AI assistant calling for Taofik and asks to go on (always on); it records only if they agree (always on);
  - a box the owner must tick ("I have a reason to call this number, and it's between 8 AM and 8 PM where they are");
  - **Place the call** stays disabled until that box is ticked.
- **Call me:** now, when its task finishes, or tomorrow at 9 AM. It calls the owner's number from Settings › People.
- **Join a meeting:**
  - paste a link and the platform is picked by itself (Google Meet, Microsoft Teams or Zoom), or choose it;
  - the next meeting from the calendar is shown;
  - who joins, and whether it may only listen or also answer when asked;
  - it announces itself in the meeting chat and leaves if asked.
- **While live:** a transcript fills in line by line. "Keep it in the background" moves it to the status bar; Hang up / Leave the meeting ends it.
- **Afterwards:** a result card in Inbox › Finished.
  - **Call:** a summary, to-dos with owners, "Draft the order" and the transcript.
  - **Meeting:** a summary, decisions, to-dos, "Send to the 4 people there", "What was said" and "Save to Library".
  - Sending the notes asks first, with the recipients listed; "Save to Library" adds a document.

**States:** off (and why); needs the Twilio key; on; consent not given; live; background (status bar); finished (result card); dismissed.

## 3. Behaviour workbook skill: "Learn this app or workflow" (novel)

**Where it lives**
- **Customize › Tools › Skills:**
  - a built-in skill, `learn-this`, first in the list;
  - a "Learn an app or workflow" card at the top whenever another skill is selected.
- **The skill's detail pane:**
  - how it works, in four numbered stages: Read it → Write the MUST list → Derive the checks → Run them for real;
  - a "Learn something new" box (what to learn, and where the checks run);
  - the list of workbooks.
- **The workbook result view:** a wide dialog.
- **Also reachable from:** the `/learn-this` slash command and What's new.

**How it behaves**
- **Start learning** walks through the four stages with live progress ("14 pages read · 13 MUSTs written · 31 checks derived"), then opens the new workbook.
- **The result view:**
  - a ring ("10/13") and "10 of 13 proved on the real thing";
  - the source, pages read, where it ran, which Trunk, and when;
  - pass / fail / not-proved counts;
  - three tabs:
    - **What it must do:** numbered MUSTs, each with a Pass / Fails / Not proved mark; failing rows are tinted.
    - **The checks:** the derived checks under each MUST, marked with the result.
    - **What didn't pass:** what really happens, and that the workbook now records it so a Trunk won't count on it.
- **Actions:**
  - **Run the checks again** reruns them and reports "Same result";
  - **Make it a skill** adds a skill "From a workbook" that the Trunk reads before working there;
  - **Save the workbook** saves it as Markdown.
- Checks that would send, buy or delete are written down but never run.

**Example data**
- "Invoice rules in Outlook": 6 of 8 proved (1 fails, 1 not proved).
- "The Hartwell Supply ordering portal": 10 of 13. It fails on a restocking fee and on delivery being added at checkout.

## 4. Decision models

**Where it lives:** Settings › Models, at Advanced ("Decision models"), with a technical group at Technical.

**How it behaves**
- The model for decisions defaults to "Qwen3.6 4B here": free, and nothing leaves the computer.
- Three switches say what it's used for: sending each message to the right Trunk, sorting the Inbox by urgency, and filtering long lists before a Trunk reads them.
- **Try it:** choose Yes or no / Pick one / Score / Filter, edit the question (and the choices or list), then **Decide**. The answer appears in place, with how sure it is, the time, the model and $0.00.
  - "Which Trunk should answer: ‘Did Hartwell charge us the late fee?’" → **Ledger**.
  - Filter over five subjects → **Kept 3 of 5**, with the dropped lines struck through.
- **Technical:** the confidence below which the task's own model decides instead, and the longest list it filters at once.
- It complements part B's "Sure-or-not checks", which shows the confidence inside a task.

**States:** idle, deciding, answered; hidden at Regular.

## 5. Words to a schedule, confirmed (Automations "Describe it")

**What v16 had:** "Add" saved an unnamed item that was off, with the note "Branch will confirm the schedule before it first runs". There was no way to confirm it.

**Where it lives now:** Automations › Scheduled, and the same box on Triggers. A proposal card appears under the box.

**How it behaves**
- The sentence becomes a structured schedule.
  - "every weekday at 8, check my inbox for invoices" → It does: "Check my inbox for invoices"; Repeats: Weekdays; At 8:00 AM; Who: Ada.
  - The Trunk is guessed from the words: mail and briefs go to Ada, receipts to Ledger.
  - It shows "**Weekdays at 8:00 AM** · first run Monday, Sep 28 at 8:00 AM". The prototype's "now" is Friday, Sep 25, 12:04 PM.
- Everything is editable on the card:
  - repeats: every day, weekdays, weekends, once a week (with a day), or monthly;
  - the time;
  - who does it;
  - the wording.
- At Technical, the cron line is shown (`0 8 * * 1-5 · America/New_York`).
- If the sentence gives no time, the time field is marked "it didn't say when", and **Confirm stays disabled** until one is picked. If Branch guessed part of it (for example "morning" → 8 AM), it says so.
- **Nothing is saved until Confirm.** Cancel says "Nothing was saved." Confirm adds the schedule, switched on, and the toast gives its first run.
- On Triggers, "when a PDF lands in Downloads, summarise it" becomes a When / It does / Who card, confirmed the same way.
- The Ideas cards (pass 15) fill the box, so they go through the same card.

## 6. Editing procedure steps: proposals with history

**Where it lives**
- The flow editor (Automations › Procedures › Open).
- A "Change suggested" pill on the procedure's row.

**How it behaves**
- **Saving a changed procedure** no longer overwrites it. It opens **"Change ‘Tidy the Downloads folder’?"**:
  - "Your edit. Nothing changes until you approve it. It stays the same procedure, as version 3; version 2 is kept in its history";
  - a line diff (+ added, − taken out, unchanged);
  - Back to editing / Approve version N.
  - Unchanged saves and empty-step checks behave as before.
- **A Trunk's suggestion:** Ledger suggests adding "If a receipt is missing → ask me first" to Month-end report, with its reason.
  - The editor shows a banner, "Ledger suggests a change · See the change".
  - The diff offers Keep it as it is / Approve version 2.
- **History:** at the bottom of the editor, each version with when and who, and "In use" on the current one. "Go back to this" is itself a proposal ("It becomes a new version, so nothing in the history is lost").
- **Approving** sets the steps and adds a version. The row reads "N steps · version N", and the toast says the old version is kept.

## 7. Connector catalogue and "add your own server"

**What v16 had:** the curated catalogue by category (pass 12), and a bare "Add your own MCP server" form that wasn't kept.

**Where it lives now**
- **Customize › Tools › Connectors › Add a connector:** the header now says every connector is scanned and fingerprinted before it runs.
- **Add your own server:** a new dialog.
- **Each connector's detail pane:** a "Safety check" section.

**How it behaves**
- **Add your own server:**
  - how it runs (a program on this computer, or a web address), a name, the command or address, and secrets from the locker;
  - **Run the check** runs **Preflight** ("answers the handshake and lists 3 tools"), **Malware scan** ("0 flags") and **Fingerprint** ("sha256 9f2c…41ab is pinned; if the program changes, Branch asks you again"), one after another;
  - **Add server** stays disabled until all three pass.
- A program on this computer then asks **"Start a program on this computer?"**, showing the exact command, what it gets from the locker, and that it asks again if the fingerprint changes. The choices are Don't start it / Allow and start.
- The server is **kept**: saved under `branch-proto-mcp17d`, so it's back after a reload, and "Start the prototype over" clears it. Remove forgets it.
- **Every connector's detail shows its safety check:**
  - preflight: answered, or "didn't answer" for Postgres;
  - malware scan;
  - fingerprint;
  - for local commands: "asks you before it starts it for the first time, and again if it changes".

## 8. Chat-app polish

**Where it lives**
- **Settings › Chat apps:** a new page under Your assistant. Part D creates it only if no other part has.
- **Each app's own page:** the setup wizard's Manage view.
- **Inbox › Needs you:** a prompt when a token is revoked.

**How it behaves**
- **Regular:** each connected app with an online/offline line and an Open button, plus "All 55 chat apps".
- **Advanced:**
  - **What the Trunk sees:** edited messages (answers the latest version), photo albums as one message, and waiting for split messages.
  - **Staying connected:** the polling-stall watchdog (reconnect after 1, 3 or 10 minutes), online/offline shown in the app, and a watchdog status row per app ("last update 4 s ago · reconnected 0 times today", or "stopped · the token was refused").
  - **Formatting in each app:** each app's own format (Telegram MarkdownV2, Slack mrkdwn, Discord Markdown, WhatsApp styles) or plain text.
- **Technical:** "Call it stalled after" (seconds), and the watchdog log path.
- **Each app's page (Manage):**
  - a status pill and line;
  - toggles: sees edited messages, albums, online status in the app;
  - the formatting choice;
  - "Paste a new token" when it's offline.
- **Revoked token:** Inbox shows "Telegram stopped: its bot token was revoked", with when, and that messages since then haven't arrived.
  - **Paste the new token** opens the wizard at Paste, with an explanation ("send /token to @BotFather…"). Saving brings it back online.
  - **Turn Telegram off** disconnects it, with Undo.

**States:** online, offline (revoked), fixed, off.

The revoked state shows the same way everywhere part D draws Telegram:
- Customize › Channels ("Offline · the bot token was revoked", with a red dot);
- Settings › Chat apps;
- the app's page;
- Inbox.

The phone's Chat apps list and the terminal's `/channels` (v16) still say connected.

## 9. Computers per Trunk

**What v16 had:** the allow-list (chips), "At once" and per-conversation viewing.

**What was wrong, and what changed**
- **"At once" never limited anything.** Adding a computer raised the limit to match the list length. Now the limit stays where the owner set it, and drops only when the list gets shorter.
- **The allow-list and the conversation's pick were the same menu.** The computer menu now starts with **"This conversation uses"** (a radio pick among the allowed computers, with "Up to 2 at once, of 3 allowed · Change"). Under it, "Allowed for Scout" (the old checkboxes).
- **New conversations fell back to the private computer.** They now start on Branch's first allowed computer, with Branch's at-once limit.
- **The Trunk's page has a new "Its computers" tab**, with:
  - every computer as a checkbox row (greyed with the reason when it isn't ready);
  - **At once** (1–4; numbers above the allowed count are disabled);
  - **A new conversation starts on** (reorders the list);
  - the Trunk's cloud computer, or the offer to set one up.

## 10. Release notes / What's new

**Where it lives**
- **Settings › Updates & about:** one row at Regular, "You have 0.19.4…", with a **Release notes** button.
- **The version menu** in the status bar: "Read the release notes".
- **What's new** (Guide): four part-D entries.

**How it behaves**
- The dialog switches between **0.19.4 · installed** and **0.20.0 · ready**, grouped New / Better / Fixed.
  - The 0.19.4 notes describe only what the page already shows (55 chat apps, models on this computer, several accounts, the gateway, checkpoints, Bitwarden sign-ins, the three levels). "Show me" links go there.
  - The 0.20.0 notes are the three items the version menu already lists, with "Install when nothing is running".
- **Flag one reply:** part C owns it ("Flag this reply", kept locally), so part D doesn't touch it.

---

## Levels and calm

- **Regular grows by 4 controls**, measured with count15 against v16:
  - Settings › Computer 61 → 62 (the cloud offer);
  - Updates 7 → 8 (Release notes);
  - Inbox › Needs you 12 → 14 (the revoked-token prompt, which is seeded as example data so the prompt can be seen).
- **Places that grow only when something happens:**
  - the + menu's two items (in a popover);
  - result cards, after a call or meeting;
  - the proposal card, only after you type;
  - the room's single offer card, which can be dismissed.
- **The new Settings › Chat apps page** holds one row per connected app at Regular.
- **Everything else is at Advanced or Technical:**
  - Voice (calls and meetings);
  - Models (decision models);
  - Chat apps (the fine controls);
  - the cron line.

## Test hook

`window.__d17()` returns the example state so check17d.cjs can read it. It's test plumbing (§1.8.1) and not part of the design.
