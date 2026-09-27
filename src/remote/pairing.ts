import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Letting one phone in, once. Switching remote access on makes a single invitation: a link shown as a
 * square barcode, and a six-digit number shown beside it. The phone opens the link and types the
 * number; only then does it receive the key that lets it use the app. The invitation is good for one
 * phone, expires after a few minutes, and dies after a handful of wrong guesses.
 */
export const pairingLifetimeMs = 5 * 60_000;
export const maximumAttempts = 5;

export interface PairingOffer {
  id: string;
  /** Shown on this computer's screen; typed on the phone. Never inside the link. */
  code: string;
  expiresAt: string;
}
export interface PairingView { id: string; expiresAt: string; attemptsLeft: number }

const digits = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");
const same = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class Pairing {
  private offer: (PairingOffer & { attempts: number }) | null = null;
  /** The window's key as it is now: removing a phone that was handed it rotates it (src/remote/window-key.ts). */
  private readonly token: () => string;
  constructor(token: string | (() => string), private readonly now: () => number = Date.now) {
    this.token = typeof token === "string" ? () => token : token;
  }

  /** Makes a fresh invitation, replacing any earlier one. */
  create(): PairingOffer {
    const offer = { id: randomUUID(), code: digits(), expiresAt: new Date(this.now() + pairingLifetimeMs).toISOString(), attempts: 0 };
    this.offer = offer;
    return { id: offer.id, code: offer.code, expiresAt: offer.expiresAt };
  }
  cancel(): void { this.offer = null; }
  /** The invitation without its number, for anything that should not learn the number. */
  view(): PairingView | null {
    const offer = this.live();
    return offer ? { id: offer.id, expiresAt: offer.expiresAt, attemptsLeft: maximumAttempts - offer.attempts } : null;
  }
  /** The number to show on this computer's screen. */
  code(): string | null { return this.live()?.code ?? null; }
  private live(): (PairingOffer & { attempts: number }) | null {
    if (this.offer && Date.parse(this.offer.expiresAt) <= this.now()) this.offer = null;
    return this.offer;
  }
  /** Checks the typed number and, when it matches, hands over the key and burns the invitation. */
  redeem(id: unknown, code: unknown): { token: string } {
    const offer = this.live();
    if (!offer) throw new Error("That invitation has expired. Make a new one on the computer.");
    if (typeof id !== "string" || typeof code !== "string" || !same(id, offer.id))
      throw new Error("That invitation is not the one this computer is offering.");
    offer.attempts++;
    if (offer.attempts > maximumAttempts) { this.offer = null; throw new Error("Too many wrong numbers. Make a new invitation on the computer."); }
    if (!same(code.trim(), offer.code)) throw new Error(`That number is not right. ${maximumAttempts - offer.attempts} tries left.`);
    this.offer = null;
    return { token: this.token() };
  }
}
