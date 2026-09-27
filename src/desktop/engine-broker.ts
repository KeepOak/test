import { z } from "zod";
import type { ChatGPTTokens, TokenVault } from "../chatgpt-auth.js";
import type { BannerWindow, BannerWindowFactory } from "../integrations/desktop-banner.js";
import type { LoginItem } from "../install/autostart.js";
import { BannerNoticeSchema } from "./engine-link.js";
import type { EngineHostOptions } from "./engine-host.js";

const BannerOpenSchema = z.object({ bannerId: z.number().int().positive(), notice: BannerNoticeSchema.optional() }).strict();
const BannerCloseSchema = z.object({ bannerId: z.number().int().positive() }).strict();
const LoginSetSchema = z.object({ enabled: z.boolean() }).strict();

export interface EngineBrokerOptions {
  vault: TokenVault;
  banner: BannerWindowFactory;
  loginItem: LoginItem | null;
  tell: (method: string) => void;
  quit: () => void;
}

/** Electron services retained by whichever desktop process owns the engine, including a detached gateway. */
export function engineBroker(options: EngineBrokerOptions): { handlers: EngineHostOptions["handlers"]; close(): void } {
  const banners = new Map<number, BannerWindow>();
  const handlers: EngineHostOptions["handlers"] = {
    "vault-read": () => options.vault.read(),
    "vault-write": (tokens) => options.vault.write(tokens as ChatGPTTokens),
    "vault-clear": () => options.vault.clear(),
    "banner-open": async (args) => {
      const { bannerId, notice } = BannerOpenSchema.parse(args);
      banners.get(bannerId)?.close();
      const shown = await options.banner(() => {
        banners.delete(bannerId);
        options.tell(`banner-closed:${bannerId}`);
      }, notice);
      banners.set(bannerId, shown);
      return true;
    },
    "banner-close": (args) => { banners.get(BannerCloseSchema.parse(args).bannerId)?.close(); return true; },
    "login-item-set": (args) => {
      if (!options.loginItem) throw new Error("Not available here");
      return options.loginItem.set(LoginSetSchema.parse(args).enabled);
    },
    quit: () => options.quit(),
  };
  return { handlers, close: () => { for (const banner of banners.values()) banner.close(); banners.clear(); } };
}
