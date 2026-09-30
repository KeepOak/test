import { BrowserWindow } from "electron";

/** One isolated, short-lived audio page; never the application page, a key, or an engine connection. */
export function notificationSound(kind: string): void {
  if (kind !== "chime" && kind !== "knock") return;
  const page = new BrowserWindow({ show: false, focusable: false, width: 1, height: 1,
    webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true,
      partition: "branch-notification-sound", autoplayPolicy: "no-user-gesture-required" } });
  const close = () => { if (!page.isDestroyed()) page.destroy(); };
  const deadline = setTimeout(close, 3000);
  page.once("closed", () => clearTimeout(deadline));
  page.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  page.webContents.on("will-navigate", (event) => event.preventDefault());
  page.webContents.session.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const script = `const audio = new AudioContext(); const at = audio.currentTime;
    const notes = ${kind === "chime" ? "[[880,0,.35],[1320,.16,.45]]" : "[[150,0,.09],[150,.16,.09]]"};
    for (const [freq,start,length] of notes) { const osc=audio.createOscillator(), gain=audio.createGain();
      osc.type=${JSON.stringify(kind === "chime" ? "sine" : "triangle")}; osc.frequency.value=freq;
      gain.gain.setValueAtTime(.0001,at+start); gain.gain.exponentialRampToValueAtTime(.25,at+start+.01);
      gain.gain.exponentialRampToValueAtTime(.0001,at+start+length); osc.connect(gain).connect(audio.destination);
      osc.start(at+start); osc.stop(at+start+length+.02); }`;
  const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'"><script>${script}</script>`;
  void page.loadURL(`data:text/html,${encodeURIComponent(html)}`).catch(close);
}
