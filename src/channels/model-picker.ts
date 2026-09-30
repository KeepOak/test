import { randomBytes } from "node:crypto";
import type { ApprovalButton } from "./router.js";

/**
 * `/model` on its own, in a chat app whose buttons can carry a list (Telegram, Discord, Slack): the connections as
 * buttons, the one answering this chat marked, and "Default" to go back to the usual choice. A press is the same as
 * typing `/model <name>`: it goes through the same command rules and changes this chat's conversation only, which is
 * where the choice is saved (per chat, as `/model <name>` always did).
 *
 * A button carries only `m:<menu>:<n>` (Telegram allows 64 bytes), never a connection's id: the menu remembers which
 * connection each number stood for, for this chat and this conversation only, and forgets it after `menuMs`. A press
 * on an old menu, another chat's menu or a menu for a conversation this chat has since left is refused in words.
 */
export const modelPickPayload = /^m:([0-9a-f]{12}):(\d{1,2}|d)$/;
/** The most connections one menu lists (Discord: five rows of five; Slack: 25 buttons), "Default" included. */
export const menuLimit = 25;
const menuMs = 15 * 60_000;

interface Menu { nonce: string; sessionId: string; ids: string[]; at: number }
export type PickResult = { preset: string | "default" } | { stale: true };

export class ModelPicker {
  private readonly menus = new Map<string, Menu>();
  constructor(private readonly now: () => number = Date.now) {}
  /** The buttons for one chat's menu; a new menu replaces that chat's last one. */
  offer(chat: string, sessionId: string, choices: { id: string; name: string }[], active: string | null): ApprovalButton[] {
    const nonce = randomBytes(6).toString("hex");
    const listed = choices.slice(0, menuLimit - 1);
    this.menus.set(chat, { nonce, sessionId, ids: listed.map((choice) => choice.id), at: this.now() });
    if (this.menus.size > 500) this.menus.delete(this.menus.keys().next().value!);
    return [
      ...listed.map((choice, index) => ({ label: `${choice.id === active ? "✓ " : ""}${choice.name}`.slice(0, 60), value: `m:${nonce}:${index}` })),
      { label: "Default", value: `m:${nonce}:d` },
    ];
  }
  /** What a pressed button chose, for this chat and the conversation it is on now; null when it is not a menu press. */
  read(chat: string, sessionId: string | undefined, text: string): PickResult | null {
    const match = modelPickPayload.exec(text.trim());
    if (!match) return null;
    const menu = this.menus.get(chat);
    if (!menu || menu.nonce !== match[1] || menu.sessionId !== sessionId || this.now() - menu.at > menuMs) return { stale: true };
    if (match[2] === "d") return { preset: "default" };
    const id = menu.ids[Number(match[2])];
    return id ? { preset: id } : { stale: true };
  }
}
export const staleModelMenu = "That model menu is out of date. Send /model for a fresh one.";
