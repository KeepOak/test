import { z } from "zod";
import { serveDesktopControl } from "./gateway-control.js";

/** Separate from the retained broker: CLI control must not displace its live-update connection. */
export function serveShellQuit(dataDir: string, quit: () => void) {
  return serveDesktopControl(dataDir, {
    quit: (args) => {
      z.object({}).strict().parse(args);
      // Acknowledge before quitting destroys the socket. This is an explicit local owner command.
      setTimeout(quit, 200);
      return { closing: true, pid: process.pid };
    },
  }, "shell");
}
