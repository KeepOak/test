import { BrowserWindow } from "electron";

/** The page's sounds (public/app/shell/notify-rules.js): the notes, and the function that plays them. */
export interface TraySoundRules {
  SOUNDS: Record<string, unknown>;
  playOn: (context: unknown, kind: string) => boolean;
}

/**
 * PLAT-192: the owner's sound with no window open. Main has no speaker of its own, so the chime or knock is played by a
 * small hidden page made for that moment and closed again: the same notes and the same code the window plays
 * (notify-rules.js), so it sounds exactly the same. Never shown; a test plays it muted. Answers whether it played.
 */
export async function playTraySound(rules: TraySoundRules, kind: string, muted = false): Promise<{ played: boolean; state?: string }> {
  if (!Object.hasOwn(rules.SOUNDS, kind)) return { played: false };
  const page = `<!doctype html><meta charset="utf-8"><script>const SOUNDS = ${JSON.stringify(rules.SOUNDS)};\nconst playOn = ${rules.playOn.toString()};</script>`;
  const player = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required", partition: "branch-tray-sound" } });
  try {
    player.webContents.setAudioMuted(muted);
    await player.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    const answer = await player.webContents.executeJavaScript(`(async () => {
      const context = new AudioContext();
      const played = playOn(context, ${JSON.stringify(kind)});
      await new Promise((done) => setTimeout(done, 1200));
      const state = context.state;
      await context.close();
      return { played, state };
    })()`) as { played: boolean; state: string };
    return answer;
  } catch {
    return { played: false };
  } finally {
    if (!player.isDestroyed()) player.destroy();
  }
}
