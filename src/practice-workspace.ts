import { z } from "zod";
import type { WorkspaceFiles } from "./files.js";
import { underProject } from "./project-scope.js"; // dogfood-ux-2
import type { Store } from "./store.js";
import { audit } from "./audit.js";

/**
 * A safe place to try things. Before someone points Branch Agent at the folder their real work is
 * in, they can switch on a practice workspace: a small folder of made-up files and a short
 * conversation already in the history, so they can watch the assistant read a file, search, and
 * write something, and see exactly what it does — without any of it touching anything they care
 * about. It is an ordinary project whose folder happens to be made for them, so leaving it is one
 * click back to the folder they were using before.
 */
export const practiceProjectId = "practice";
export const practiceFolder = "practice-workspace";

interface SampleFile { path: string; text: string }
/** The made-up files. Nothing here is real, and all of it is safe to change or delete. */
const sampleFiles: SampleFile[] = [
  {
    path: "read-me-first.md",
    text: `# This is a practice workspace

Nothing in this folder is real. It was made so you can watch Branch Agent work
before you point it at your own files.

Things worth trying:

- "What is in this folder?"
- "Read notes/meeting-notes.md and tell me what I agreed to do."
- "Add a line to notes/shopping.txt saying we need more coffee."
- "Which of these files mentions the invoice?"

When you are ready, choose "Use my real folder" and this workspace stays behind,
untouched, in case you want to come back to it.
`,
  },
  {
    path: "notes/meeting-notes.md",
    text: `# Tuesday catch-up

Present: Sam, Alex, Priya

- Sam will send the invoice to Northgate by Friday.
- Alex is redoing the front page so the phone number is easier to find.
- Priya asked whether we still need the Wednesday call. We agreed to drop it.

Next catch-up: the Tuesday after next.
`,
  },
  {
    path: "notes/shopping.txt",
    text: "milk\nbread\nprinter paper\n",
  },
  {
    path: "invoices/northgate-2024-11.csv",
    text: "date,description,amount\n2024-11-03,Site visit,240.00\n2024-11-14,Report writing,480.00\n2024-11-21,Follow-up call,90.00\n",
  },
];

/** The conversation already in the history, so the app is not empty on the first morning. */
const demoConversation: { role: "user" | "assistant"; content: string }[] = [
  { role: "user", content: "What is in this folder?" },
  {
    role: "assistant",
    content: `There are four files here:

- read-me-first.md — a short note explaining that this is a practice workspace
- notes/meeting-notes.md — notes from a Tuesday catch-up
- notes/shopping.txt — a short shopping list
- invoices/northgate-2024-11.csv — three lines of invoice figures for November

Nothing here is real, so anything you ask me to change is safe to change.`,
  },
  { role: "user", content: "What did Sam agree to do?" },
  {
    role: "assistant",
    content: `From notes/meeting-notes.md: Sam agreed to send the invoice to Northgate by Friday.

The matching figures are in invoices/northgate-2024-11.csv — three lines coming to 810.00.`,
  },
];

export interface PracticeState {
  /** True while the practice project is the one in use. */
  active: boolean;
  /** True once the practice workspace has been made, whether or not it is in use now. */
  exists: boolean;
  folder: string;
  files: string[];
  /** The folder the person was using before they switched, so they can go back to it. */
  previousProject: string | null;
}

const previousKey = "practice-previous-project";
export const PracticeSwitchSchema = z.object({
  /** True to use the practice workspace, false to go back to the real one. */
  practice: z.boolean(),
}).strict();

export class PracticeWorkspace {
  constructor(private readonly store: Store, private readonly files: WorkspaceFiles) {}

  state(owner: string): PracticeState {
    const projects = this.store.projects;
    const exists = projects.list(owner).some((project) => project.id === practiceProjectId);
    const previous = this.store.get("settings", owner, previousKey)?.data as { id?: string } | undefined;
    return {
      active: projects.chosen(owner).id === practiceProjectId,
      exists, folder: practiceFolder,
      files: sampleFiles.map((file) => `${practiceFolder}/${file.path}`),
      previousProject: previous?.id ?? null,
    };
  }

  /**
   * Makes the practice project, moves into it so file paths land inside its own folder, then
   * writes the made-up files and the demo conversation. Doing it twice changes nothing.
   */
  async create(owner: string, signal: AbortSignal = AbortSignal.timeout(30000)): Promise<{ created: string[]; sessionId: string | null }> {
    this.store.projects.save(owner, {
      id: practiceProjectId, name: "Practice workspace",
      instructions: "This is a practice workspace of made-up files. Nothing here is real, so you may read, change and delete freely.",
      modelPreset: null, repository: "", folder: practiceFolder,
    });
    // dogfood-ux-2: the files are written as work of the practice project (its folder), without moving the owner's pick,
    // so nothing running elsewhere is moved into the practice folder while they are written.
    const created: string[] = [];
    await underProject(practiceProjectId, async () => {
      for (const file of sampleFiles) {
        const already = await this.files.read(file.path).then(() => true).catch(() => false);
        if (already) continue;
        await this.files.write(file.path, file.text, signal);
        created.push(`${practiceFolder}/${file.path}`);
      }
    });
    return { created, sessionId: this.seedConversation(owner) };
  }

  /** The demo conversation, written once; a second call leaves the first one alone. */
  private seedConversation(owner: string): string | null {
    const marker = this.store.get("settings", owner, "practice-session")?.data as { sessionId?: string } | undefined;
    if (marker?.sessionId && this.store.ownsSession(owner, marker.sessionId)) return marker.sessionId;
    const sessionId = this.store.createSession(owner);
    for (const message of demoConversation) this.store.message(sessionId, message);
    this.store.save("settings", owner, "practice-session", { sessionId });
    return sessionId;
  }

  /** Switches into the practice workspace, or back to whatever was in use before it. */
  async switch(owner: string, input: unknown): Promise<PracticeState> {
    const { practice } = PracticeSwitchSchema.parse(input);
    if (practice) {
      const current = this.store.projects.chosen(owner).id;
      if (current !== practiceProjectId) this.store.save("settings", owner, previousKey, { id: current });
      await this.create(owner);
      this.store.projects.setActive(owner, { active: practiceProjectId });
    } else {
      const previous = this.store.get("settings", owner, previousKey)?.data as { id?: string } | undefined;
      const wanted = previous?.id && this.store.projects.list(owner).some((p) => p.id === previous.id) ? previous.id : "default";
      this.store.projects.setActive(owner, { active: wanted });
    }
    audit(this.store, owner, {
      action: "practice.switched", actor: owner, subject: practice ? "practice workspace" : "real workspace",
      reason: practice ? "Trying tools safely on made-up files" : "Going back to the real folder",
      outcome: "saved",
    });
    return this.state(owner);
  }
}
