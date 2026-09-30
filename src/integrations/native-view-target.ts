/** Initial native viewer grant: external application windows with trusted runner process provenance only. */
export function nativeWindowViewable(value: unknown, excludedProcessId: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const window = value as Record<string, unknown>;
  if (!Number.isSafeInteger(excludedProcessId) || excludedProcessId <= 0 || !Number.isSafeInteger(window.processId)
    || Number(window.processId) <= 0 || window.processId === excludedProcessId || window.minimised === true) return false;
  if (typeof window.program !== 'string' || typeof window.className !== 'string' || !window.className.trim()) return false;
  const program = window.program.trim().toLowerCase().replace(/\.exe$/, '');
  if (!/^[a-z0-9_. -]{1,120}$/.test(program)) return false;
  if (/^(?:chrome|chromium|msedge|msedgewebview2|firefox|brave|opera|vivaldi|iexplore|electron|branch(?:[ ._-]agent)?|arc|browser|zen|waterfox|librewolf|floorp|thorium|ungoogled-chromium)$/.test(program)) return false;
  return !/chrome_widget|chromium|mozilla|webview|cefbrowser/i.test(window.className);
}
