import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { partSettings, requireAsk } from "./settings.js";

/**
 * A0794: projects that hold their own work, not only their instructions and secrets. A saved flow,
 * a schedule or an incoming trigger can be put under a project; the project's board then shows those
 * together with the tasks that were done under it, newest first. Nothing is moved or changed by
 * putting a thing under a project: it is a label the board reads, kept in one settings record, and
 * a thing under no project stays on the default project's board.
 */
export const boardItemKinds = ["flow", "schedule", "trigger"] as const;
export type BoardItemKind = (typeof boardItemKinds)[number];

const AssignmentsSchema = z.object({ items: z.record(z.string(), z.string()).default({}) }).strict();
const assignmentsKey = "asks-project-board-items";

export const AssignSchema = z.object({
  kind: z.enum(boardItemKinds),
  id: z.string().trim().min(1).max(64),
  /** The project to put it under; null takes it back to the default project. */
  project: z.string().trim().min(1).max(64).nullable(),
}).strict();

export interface BoardItem { kind: BoardItemKind; id: string; name: string }
export interface ProjectBoard {
  project: { id: string; name: string; active: boolean };
  flows: BoardItem[]; schedules: BoardItem[]; triggers: BoardItem[];
  tasks: { id: string; status: string; prompt: string; createdAt: string }[];
}

/** What the board needs from the rest of Branch, handed in so a test can give plain lists. */
export interface BoardSources {
  flows: () => { id: string; name: string }[];
}

export class ProjectBoards {
  constructor(private readonly store: Store, private readonly owner: string, private readonly sources: BoardSources) {}

  private assignments(): Record<string, string> {
    return partSettings(this.store, this.owner, assignmentsKey, AssignmentsSchema).items;
  }

  /** Every thing that exists today, with its name, so a board never lists something deleted. */
  private everything(): BoardItem[] {
    const named = (kind: BoardItemKind, table: "schedules" | "triggers") => this.store.list(table, this.owner).map((record) => ({
      kind, id: record.id, name: String(record.data.name ?? record.data.prompt ?? record.id).slice(0, 120),
    }));
    return [
      ...this.sources.flows().map((flow) => ({ kind: "flow" as const, id: flow.id, name: flow.name })),
      ...named("schedule", "schedules"), ...named("trigger", "triggers"),
    ];
  }

  assign(input: unknown): { kind: BoardItemKind; id: string; project: string } {
    requireAsk(this.store, this.owner, "project-board");
    const { kind, id, project } = AssignSchema.parse(input);
    if (!this.everything().some((item) => item.kind === kind && item.id === id)) throw new Error(`There is no ${kind} with that id`);
    if (project && !this.store.projects.list(this.owner).some((p) => p.id === project)) throw new Error("Project not found");
    const items = { ...this.assignments() };
    if (project && project !== "default") items[`${kind}:${id}`] = project;
    else delete items[`${kind}:${id}`];
    this.store.save("settings", this.owner, assignmentsKey, { items });
    return { kind, id, project: project ?? "default" };
  }

  /** One project's board; with no id, the active project's. */
  board(projectId?: string): ProjectBoard {
    requireAsk(this.store, this.owner, "project-board");
    const active = this.store.projects.active(this.owner);
    const project = projectId ? this.store.projects.list(this.owner).find((p) => p.id === projectId) : active;
    if (!project) throw new Error("Project not found");
    const assigned = this.assignments();
    const mine = this.everything().filter((item) => (assigned[`${item.kind}:${item.id}`] ?? "default") === project.id);
    return {
      project: { id: project.id, name: project.name, active: project.id === active.id },
      flows: mine.filter((item) => item.kind === "flow"),
      schedules: mine.filter((item) => item.kind === "schedule"),
      triggers: mine.filter((item) => item.kind === "trigger"),
      tasks: this.tasks(project.id),
    };
  }

  private tasks(projectId: string): ProjectBoard["tasks"] {
    return this.store.sqlite.prepare(
      "SELECT id, status, prompt, created_at FROM tasks WHERE owner=? AND project=? ORDER BY created_at DESC LIMIT 20",
    ).all(this.owner, projectId).map((row) => ({
      id: String(row.id), status: String(row.status), prompt: String(row.prompt).slice(0, 160), createdAt: String(row.created_at),
    }));
  }
}

export function registerProjectBoard(registry: ToolRegistry, boards: ProjectBoards): void {
  registry.register({
    // Ships-on sweep (2026-09-26): a project's flows and schedules belong with schedules, keeping the memory box inside its budget.
    name: "project.board", group: "schedules", permission: "projects.read",
    description: "Show one project's board: the flows, schedules and triggers put under it, and the tasks done under it. With no project, the active one.",
    parameters: z.object({ project: z.string().trim().min(1).max(64).optional() }).strict(),
    execute: async (input) => boards.board(input.project),
  });
  registry.register({
    name: "project.assign", group: "schedules", permission: "projects.manage",
    description: "Put a saved flow, a schedule or a trigger under a project, so it shows on that project's board. Nothing about the thing itself changes.",
    parameters: AssignSchema,
    execute: async (input) => boards.assign(input),
    target: (input) => `${input.kind}:${input.id}`,
  });
}
