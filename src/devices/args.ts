import { z } from "zod";
import type { Capability } from "./capabilities.js";

/**
 * mac7/nodes: what each capability accepts. Branch checks these before it asks a device, and the
 * device checks them again before it does anything, so a message that did not come through Branch's
 * tool gate still cannot widen what a device will do.
 */
const Url = z.string().trim().url().max(2048).refine((value) => /^https?:\/\//i.test(value), "Only web addresses (http or https) can be opened");
const Relative = z.string().trim().max(500).refine((value) => !/^([\\/]|[A-Za-z]:)/.test(value) && !value.split(/[\\/]/).includes(".."),
  "Name a place inside the chosen folder, without .. or a full path");

export const deviceArgs = {
  camera: z.object({ facing: z.enum(["front", "back"]).default("back") }).strict(),
  screen: z.object({}).strict(),
  location: z.object({}).strict(),
  notify: z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().max(1000).default("") }).strict(),
  "clipboard-read": z.object({}).strict(),
  "clipboard-write": z.object({ text: z.string().max(20000) }).strict(),
  "open-url": z.object({ url: Url }).strict(),
  run: z.object({
    executable: z.string().trim().min(1).max(200).regex(/^[^\s;&|`$<>]+$/, "Name one program, without shell characters"),
    args: z.array(z.string().max(4000)).max(64).default([]),
    timeoutSeconds: z.number().int().min(1).max(300).default(60),
  }).strict(),
  files: z.object({ action: z.enum(["list", "read"]), path: Relative.default("") }).strict(),
  speak: z.object({ text: z.string().trim().min(1).max(2000) }).strict(),
  listen: z.object({ seconds: z.number().int().min(1).max(30).default(5) }).strict(),
  canvas: z.object({ html: z.string().max(60000).optional(), url: Url.optional() }).strict()
    .refine((value) => Boolean(value.html) !== Boolean(value.url), "Give either a page (html) or an address (url)"),
  // computer-control: one press, words, a key or the wheel from the owner's view, at a share of the screen last seen.
  input: z.object({
    action: z.enum(["click", "type", "key", "scroll"]),
    x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(),
    button: z.enum(["left", "right", "middle"]).default("left"),
    count: z.number().int().min(1).max(3).default(1),
    text: z.string().min(1).max(2000).optional(),
    chord: z.string().trim().min(1).max(40).regex(/^[a-z0-9]+(\+[a-z0-9]+){0,3}$/i, "Name a key such as enter or ctrl+s").optional(),
    steps: z.number().int().min(-10).max(10).refine((n) => n !== 0).optional(),
  }).strict().refine((value) => value.action === "type" ? value.text !== undefined
    : value.action === "key" ? value.chord !== undefined
    : value.x !== undefined && value.y !== undefined && (value.action === "click" || value.steps !== undefined), "That input is missing what it needs"),
} satisfies Record<Capability, z.ZodType>;

export function parseDeviceArgs(capability: Capability, args: unknown): Record<string, unknown> {
  return deviceArgs[capability].parse(args ?? {}) as Record<string, unknown>;
}
