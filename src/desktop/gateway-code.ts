import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Gateway, gatewayCodeContract } from "../never-break/gateway.js";
import { checkedInUse, readLiveState, type InUse } from "../hot-update/live-folder.js";

export interface PreparedGatewayCode { apply(): void; rollback(): void }
type GatewayModule = { Gateway: { prototype: object }; gatewayCodeContract: number };

/** The stop entry belongs to the resident owner. Its stable wrapper dispatches stopRetained to the adopted code. */
function methodsOf(prototype: object): PropertyDescriptorMap {
  const methods = Object.getOwnPropertyDescriptors(prototype);
  Reflect.deleteProperty(methods, "constructor");
  Reflect.deleteProperty(methods, "stop");
  if (Object.values(methods).some((method) => typeof method.value !== "function" || method.get || method.set))
    throw new Error("The gateway replacement contains an unsupported method layout.");
  return methods;
}

/** Validate the whole live manifest before importing code into the process that owns the public listener. */
export async function prepareGatewayCode(appRoot: string, gateway: Gateway, inUse: InUse): Promise<PreparedGatewayCode> {
  const checked = await checkedInUse(appRoot, inUse);
  if (!checked || checked.manifest.version !== inUse.version) throw new Error("The gateway build did not match the checked update.");
  const candidate = await import(pathToFileURL(join(checked.dir, "dist", "never-break", "gateway.js")).href) as GatewayModule;
  if (candidate.gatewayCodeContract !== gatewayCodeContract || !candidate.Gateway?.prototype)
    throw new Error("This gateway update needs a packaged restart because its resident-state contract changed.");
  const stop = Object.getOwnPropertyDescriptor(candidate.Gateway.prototype, "stop")?.value as unknown;
  if (typeof stop !== "function" || stop.toString() !== Gateway.prototype.stop.toString())
    throw new Error("This gateway update needs a packaged restart because its owner stop entry changed.");
  const next = methodsOf(candidate.Gateway.prototype), expected = methodsOf(Gateway.prototype);
  if (Object.keys(next).sort().join("\n") !== Object.keys(expected).sort().join("\n"))
    throw new Error("This gateway update needs a packaged restart because its method contract changed.");
  const previous = Object.fromEntries(Object.keys(next).map((name) => [name, Object.getOwnPropertyDescriptor(gateway, name)]));
  if (Object.values(previous).some((descriptor) => descriptor && !descriptor.configurable))
    throw new Error("The resident gateway cannot replace these methods safely.");
  return preparedCode(gateway, next, previous, inUse.version);
}

function preparedCode(gateway: Gateway, next: PropertyDescriptorMap,
  previous: Record<string, PropertyDescriptor | undefined>, version: string): PreparedGatewayCode {
  let applied = false, previousVersion = "";
  const rollback = () => {
    if (!applied) return;
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(gateway, name, descriptor);
      else Reflect.deleteProperty(gateway, name);
    }
    gateway.useCodeVersion(previousVersion);
    applied = false;
  };
  return { rollback, apply: () => {
    if (applied) throw new Error("The prepared gateway code is already in use.");
    const url = gateway.url, worker = JSON.stringify(gateway.health().worker);
    previousVersion = gateway.useCodeVersion(version);
    applied = true;
    try {
      Object.defineProperties(gateway, next);
      if (gateway.url !== url || JSON.stringify(gateway.health().worker) !== worker)
        throw new Error("The replacement gateway did not retain its worker and public address.");
    }
    catch (error) { rollback(); throw error; }
  } };
}

/** A restart uses the same checked build as its engine; old live builds without this contract leave packaged code intact. */
export async function restoreGatewayCode(appRoot: string, gateway: Gateway): Promise<void> {
  const { engine } = await readLiveState(appRoot);
  if (!engine) return;
  try { (await prepareGatewayCode(appRoot, gateway, engine)).apply(); }
  catch (error) { gateway.note(`Resident gateway code was kept: ${error instanceof Error ? error.message : String(error)}`); }
}
