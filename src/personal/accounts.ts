import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import type { SignInService } from "./signin.js";

/** Alphanumeric IDs cannot collide when OAuth locker names replace hyphens with underscores. */
export const PersonalAccountId = z.string().regex(/^[a-z][a-z0-9]{0,19}$/);
const Account = z.object({ id: PersonalAccountId, label: z.string().trim().min(1).max(60) }).strict();
const Accounts = z.object({ selected: PersonalAccountId, accounts: z.array(Account).min(1).max(8) }).strict();
const AddAccount = z.object({ label: Account.shape.label }).strict();

export const personalProviderId = (service: SignInService, account: string): string =>
  account === "default" ? `personal-${service}` : `personal-${service}-${PersonalAccountId.parse(account)}`;
export const personalSettingsKey = (service: SignInService, account: string): string =>
  account === "default" ? `personal-signin-${service}` : `personal-signin-${service}-${PersonalAccountId.parse(account)}`;
export const personalClientSecretName = (service: SignInService, account: string): string =>
  account === "default" ? `${service.toUpperCase()}_SIGNIN_CLIENT_SECRET` : `${service.toUpperCase()}_${PersonalAccountId.parse(account).toUpperCase()}_SIGNIN_CLIENT_SECRET`;

/** A virtual default preserves existing settings and OAuth tokens in place; nothing is copied or deleted. */
export class PersonalAccounts {
  constructor(private readonly store: Store, private readonly owner: string, private readonly service: SignInService) {}
  private key(): string { return `personal-accounts-${this.service}`; }
  private read(): z.infer<typeof Accounts> {
    const saved = this.store.get("settings", this.owner, this.key())?.data;
    const value = saved === undefined ? { selected: "default", accounts: [{ id: "default", label: "Default account" }] } : Accounts.parse(saved);
    if (new Set(value.accounts.map((account) => account.id)).size !== value.accounts.length || !value.accounts.some((a) => a.id === value.selected))
      throw new Error("The saved account selection is invalid. Choose an existing account.");
    return value;
  }
  list() { return this.read(); }
  resolve(id?: string): string {
    const value = this.read(), selected = PersonalAccountId.parse(id ?? value.selected);
    if (!value.accounts.some((account) => account.id === selected)) throw new Error("There is no personal account with that ID.");
    return selected;
  }
  add(input: unknown) {
    const { label } = AddAccount.parse(input), value = this.read();
    if (value.accounts.length >= 8) throw new Error("A service can keep up to eight accounts.");
    const account = { id: `a${randomBytes(6).toString("hex")}`, label };
    value.accounts.push(account);
    this.store.save("settings", this.owner, this.key(), value);
    return account;
  }
  select(id: string) {
    const value = this.read();
    value.selected = this.resolve(id);
    this.store.save("settings", this.owner, this.key(), value);
    return this.list();
  }
}
