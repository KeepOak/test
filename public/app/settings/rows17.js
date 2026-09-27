/* Pass 17's settings rows (prototype patch17b: rowB17, demoB17, sec15 with a note), 1:1 in markup. WORDS holds each
   Settings row's own words, [title, row text, button], from the prototype with its example data taken out (a count
   written into a button, a made-up project or Trunk name): those parts are left empty or come from the engine. */
import { esc } from "../core/dom.js";
import { demoRow17 } from "../places/demo17.js";

export const WORDS = {
  balance: ["Prepaid balances", "For services that sell credit, how much is left, checked when you open this page.", "Check now"],
  projcost: ["What each project cost", "Spend by project and by conversation, for the last 30 days.", "See projects"],
  backup: ["Backups", "A copy of your conversations, memory and settings, on a schedule you choose.", "See backups"],
  retention: ["Saved before it’s deleted", "Conversations older than your limit are exported to a file first, then removed.", "See the next one"],
  held: ["Things held for your yes", "After a restore, anything that didn’t match waits here instead of being overwritten.", "See"],
  localroute: ["Private things stay here", "", "See what stays"],
  jev: ["Sure-or-not checks", "Small yes-or-no checks inside a task come with a confidence; a low one asks a better model.", "Show one"],
  debate: ["Stress-test the answer", "A second model argues against the first answer before you see it.", "Show an example"],
  provplug: ["Model services from plugins", "A plugin can bring a way to reach a model service Branch doesn’t know yet.", "See installed"],
  retired: ["Retired models and hiccups", "Automatic: a retired model moves to its named successor, and a brief failure is tried again.", "Last 7 days"],
  mediapaths: ["Programs for sound and video", "Where Branch finds ffmpeg and yt-dlp. Found by itself.", "Check"],
  terms: ["Each service’s terms", "Branch only signs in to a plan the way its service allows, and says so.", "Read the lines"],
  trust: ["Trusted folders", "Folders a Trunk may change without asking. A new project folder asks the first time.", "See"],
  audit: ["Every change to what Branch may reach", "Each time access widens or narrows it’s written down. Export it as a spreadsheet.", "See the record"],
  practice: ["A practice workspace", "A folder of made-up files where a Trunk can try something risky first.", "Open it"],
  injection: ["Outside content is only information", "Always on: web pages, emails and files are treated as information, never as instructions.", "Show an example"],
  chatperm: ["Tasks started from chat apps", "A task started from Telegram or WhatsApp may only read, unless you write a line allowing more.", "See the four"],
  loopguard: ["Loops and empty answers", "Always on: a task going in circles is stopped, and an empty answer counts as a failure.", "Last week"],
  leakguard: ["Keys never land in transcripts", "Always on: a key or password that shows up in output is blanked before it’s saved or sent.", "Show an example"],
  codecheck: ["Check scripts before they run", "Looks for forbidden calls, hidden decoders and disguised commands in any script a Trunk writes.", "Check an example"],
  keys: ["Keys Branch holds", "Which keys are set and when they were last used, without ever showing them.", "See"],
  locker: ["Keys kept apart from settings", "Keys live in a locker only the engine reads, so sharing your settings never shares a key.", "Show where"],
  tokens: ["Sign-in tokens", "Tokens from “sign in with…” are encrypted, refreshed before they expire, and revoked when removed.", "Check them"],
  troubleshoot: ["Fix and run again", "When a command fails, it reads the error, fixes it and runs it again, with the same permissions.", "Show an example"],
  bgproc: ["Programs that keep running", "A Trunk can start a server or a watcher and check on it later.", "See running"],
  screenwatch: ["Watch part of the screen", "A Trunk watches a region, like a progress bar, and acts when it changes.", "Show an example"],
  profiles: ["Browser profiles that stay signed in", "Each Trunk can keep its own browser profile, so it doesn’t sign in every time.", "See"],
  devpick: ["A device for one conversation", "Lend a phone’s camera or location to one conversation, not all of them.", "Show it"],
  editor: ["Edit files in Branch", "A small editor for project files, with the same folder rules as Trunks.", "Open one"],
  jobobj: ["Limits for commands", "On Windows, commands run inside a job with a memory and processor ceiling.", "Show limits"],
  tgdepth: ["Telegram, in depth", "Mentions in groups, long replies, live typing and approval buttons.", "See all"],
  delivery: ["Messages that always arrive", "Every outgoing message is written down and tried again until the app takes it.", "See the record"],
  voicenote: ["Voice notes from chat apps", "A voice note sent in Telegram or WhatsApp is turned into words on this computer.", "Show one"],
  broadcast: ["Send to several chats", "One message, or a daily digest, to several chats at once.", "Set up a digest"],
  router: ["Which Trunk answers", "Rules that send a chat-app message to the right Trunk, or answer simple ones by themselves.", "See rules"],
  hookaddr: ["Addresses for chat apps", "Each chat app reaches Branch at its own address. Change one if it leaks.", "See addresses"],
  claims: ["Numbered sources you can check", "Each claim in a brief has a number that opens the passage it came from.", "See an example"],
  consolidate: ["Tidy by meaning each night", "It merges facts that say the same thing in different words. Every merge is listed.", "Last night"],
  wsmem: ["Project notes as files", "Each project keeps its memory as Markdown in its own folder, so you can read and edit it.", "Open"],
  followup: ["Follow-ups made whole", "A short follow-up like “and July?” becomes a full question before it searches.", "Show one"],
  scratch: ["Scratch space for pasted text", "Long text you paste is used for that job, then let go. It never becomes memory.", "Show it"],
  kcards: ["Knowledge cards", "A short card made from a conversation: the question, the answer and where it came from.", "See"],
  reachnotes: ["Notes it keeps for itself", "Short working notes a Trunk writes and rewrites, such as how a site behaves.", "Read them"],
  health: ["Health", "Readouts only; nothing to set.", "See readouts"],
  fixhints: ["Errors that say how to fix them", "When a service refuses, the message says what to do, not only the code.", "Show one"],
  sdk: ["Build on Branch", "Kits for JavaScript and Python, an OpenAPI description, and a mode without the window.", "See them"],
  cli: ["The branch command", "Everything in the window from a terminal, with JSON output for scripts.", "See examples"],
  events: ["Events for your programs", "A stream of what happens in Branch that your own programs can follow.", "Show the stream"],
  scopes: ["Keys for scripts and phones", "Short-lived keys that can only do what you tick.", "Make a key"],
  tracing: ["Send traces elsewhere", "Every round and tool as a trace, sent to OpenTelemetry, Langfuse, LangSmith or Prometheus.", "Choose"],
  studies: ["Studies", "Run the same tasks again later and compare, with a journal of what changed.", "See the last"],
  toolreport: ["What went with the last request", "What travelled with the last message to the model, and how much room each part took.", "Show it"],
  surfaces: ["Live panels and app blocks", "Tools can show a live panel in a conversation, and other runtimes can plug in.", "See them"],
  flowyaml: ["Procedures as text", "Any procedure can be read and edited as YAML, and checked before it runs.", "Show one"],
  handbook: ["The handbook", "Answers to “how do I…” questions, found by what you ask.", "Ask it"],
  updfix: ["If an update fails", "A Trunk reads what went wrong, tries the fix on a copy and tells you.", "Show an example"],
  signed: ["Signed household records", "Changes people make are signed, so it’s clear who did what; code changes come as patches.", "See the last"],
  voiceapprove: ["Answer approvals by voice", "Say yes or no to an approval, or hold the phone key to talk turn by turn.", "Try one"],
  frame: ["Window frame", "Branch’s own title bar or the system one.", "Choose"],
  talksettings: ["Change settings by talking", "", "Show an example"],
  learncore: ["Suggestions made on this computer", "Small suggestions from what you do, worked out here without asking a model.", "See"],
};

/** One key's row; `label` replaces the button's words when the engine gives a count ("See 3"). */
export const demo17 = (key, label) => demoRow17(key, label ? [WORDS[key][0], WORDS[key][1], label] : WORDS[key]);
export const demos17 = (keys) => keys.map((k) => demo17(k)).join("");

/** The prototype's rowB17: a titled row with one button carrying its own action. */
export const row17 = (title, sub, label, act, attrs = "") =>
  `<div class="ctl"><b>${esc(title)}</b><span class="right"><button class="btn sm" type="button" data-act="${esc(act)}" ${attrs}>${esc(label)}</button></span><small>${esc(sub)}</small></div>`;

/** The prototype's sec15 with its optional note. */
export const sec17 = (title, rows, note = "") =>
  `<div class="sec x15-sec"><h2>${esc(title)}</h2>${note ? `<p class="hint">${esc(note)}</p>` : ""}${rows}</div>`;

/** The prototype's pill: kind and words. */
export const pill17 = (kind, words) => `<span class="pill ${esc(kind)}"><i></i>${esc(words)}</span>`;
