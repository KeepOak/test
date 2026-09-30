import { execFile } from "node:child_process";
import { win32 } from "node:path";

export type ListPrograms = (imageName: string) => Promise<string[]>;

/** Every running program's path with this file name, from the system's own process list (Windows). */
export const listPrograms: ListPrograms = (imageName) => new Promise((resolve, reject) => {
  const powershell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const filter = `Name='${imageName.replace(/'/g, "''")}'`;
  execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { $_.ExecutablePath }`],
  { windowsHide: true, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).split(/\r?\n/).filter(Boolean))));
});

/** Whether any process runs from exactly this program path. Asked by path, never by name alone. */
export async function programInUse(program: string, list: ListPrograms = listPrograms): Promise<boolean> {
  const wanted = program.toLowerCase();
  return (await list(win32.basename(program))).some((path) => path.trim().toLowerCase() === wanted);
}
