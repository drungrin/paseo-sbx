import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { ServerDeps } from "./hooks";
import { newLockToken, withSandboxLock } from "./lock";
import { assertSandboxName, prepareSandbox, runSbxOk } from "./sbx";
import { buildSpec } from "./spec-builder";
import { readSandboxState, writeSandboxState, type Publication } from "./state";

export const RELAY_FIRST = 41000;
export const RELAY_LAST = 41999;

/** Same allocation as allocateRelayPort in the wrapper. */
export function allocateRelayPort(publications: readonly Publication[], guestPort: number, avoid: readonly number[]): number {
  const used = new Set([...publications.map((publication) => publication.relayPort), ...avoid]);
  const span = RELAY_LAST - RELAY_FIRST + 1;
  for (let i = 0; i < span; i++) {
    const candidate = RELAY_FIRST + ((guestPort + i) % span);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`no free relay port in ${RELAY_FIRST}-${RELAY_LAST}`);
}

const MAX_SNAPSHOT_BYTES = 64 * 1024;

const snapshotSchema = z.object({
  at: z.number(),
  listeners: z
    .array(z.object({ port: z.number().int().min(1).max(65535), addresses: z.array(z.string().max(64)).max(8) }))
    .max(500),
});
export type ListenerSnapshot = z.infer<typeof snapshotSchema>;

/**
 * The guest agent's snapshot of listening ports. The guest writes it, so it is untrusted input:
 * bounded in size, validated, and ignored when it does not parse.
 */
export function readListeners(claudeConfigDir: string): ListenerSnapshot | null {
  const file = join(claudeConfigDir, ".paseo-sbx", "listeners.json");
  try {
    if (statSync(file).size > MAX_SNAPSHOT_BYTES) return null;
    return snapshotSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** Ports the guest agent was told are the plugin's own (Paseo's MCP relay and the like). */
export function internalPorts(claudeConfigDir: string): number[] {
  try {
    const file = join(claudeConfigDir, ".paseo-sbx", "relays.json");
    if (statSync(file).size > MAX_SNAPSHOT_BYTES) return [];
    const data = JSON.parse(readFileSync(file, "utf8")) as { internal?: unknown };
    return Array.isArray(data.internal) ? data.internal.filter((port): port is number => Number.isInteger(port)) : [];
  } catch {
    return [];
  }
}

export interface ActualPublication {
  host_ip: string;
  host_port: number;
  sandbox_port: number;
  protocol: string;
}

/** What sbx publishes for the sandbox through relay ports. Listing does not start the VM. */
export async function actualPublications(deps: ServerDeps, name: string): Promise<ActualPublication[]> {
  const stdout = await runSbxOk(deps.paths, ["ports", name, "--json"], "sbx ports");
  return (JSON.parse(stdout || "[]") as ActualPublication[]).filter(
    (entry) => entry.sandbox_port >= RELAY_FIRST && entry.sandbox_port <= RELAY_LAST,
  );
}

function isFreeHostPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

type PaseoApi = PluginHandlerContext["paseo"];

async function applyPublications(deps: ServerDeps, name: string, change: (current: Publication[]) => Publication[]) {
  const { paths } = deps;
  assertSandboxName(name);
  const state = readSandboxState(paths, name);
  if (!state?.workspace || !state.key) throw new Error(`${name} has no record of how it was created`);
  const settings = await deps.readSettings();
  const { spec } = await buildSpec({
    settings,
    workspaceId: null,
    cwd: state.workspace,
    paths,
    binding: { key: state.key, name, claudeConfigDir: state.claudeConfigDir ?? join(paths.claudeConfigs, name) },
  });
  const token = newLockToken();
  await withSandboxLock(paths, name, token, async () => {
    const current = readSandboxState(paths, name) ?? state;
    writeSandboxState(paths, name, { ...current, publications: change(current.publications ?? []) });
    // The wrapper's ensure step reconciles sbx with the list and starts the relays.
    await prepareSandbox(paths, spec, token);
  });
}

export interface PublishRequest {
  name: string;
  guestPort: number;
  allInterfaces: boolean;
  /** A fixed host port to reserve; null lets sbx or the plugin pick one. */
  hostPort: number | null;
}

/** Publishes a guest port through a relay. Starts the VM when it is stopped. */
export async function publishPort(deps: ServerDeps, _paseo: PaseoApi, request: PublishRequest): Promise<void> {
  const state = readSandboxState(deps.paths, request.name);
  const claudeConfigDir = state?.claudeConfigDir ?? join(deps.paths.claudeConfigs, request.name);
  const internal = internalPorts(claudeConfigDir);
  if (internal.includes(request.guestPort) || (request.guestPort >= RELAY_FIRST && request.guestPort <= RELAY_LAST)) {
    throw new Error(`port ${request.guestPort} belongs to the plugin`);
  }
  if (request.hostPort !== null && !(await isFreeHostPort(request.hostPort, request.allInterfaces ? "0.0.0.0" : "127.0.0.1"))) {
    throw new Error(`host port ${request.hostPort} is already taken`);
  }
  await applyPublications(deps, request.name, (current) => {
    const others = current.filter((publication) => publication.guestPort !== request.guestPort);
    const previous = current.find((publication) => publication.guestPort === request.guestPort);
    return [
      ...others,
      {
        guestPort: request.guestPort,
        relayPort: previous?.relayPort ?? allocateRelayPort(others, request.guestPort, internal),
        hostPort: request.hostPort,
        allInterfaces: request.allInterfaces,
        reserved: request.hostPort !== null,
        auto: false,
      },
    ];
  });
}

export async function unpublishPort(deps: ServerDeps, name: string, guestPort: number): Promise<void> {
  await applyPublications(deps, name, (current) => current.filter((publication) => publication.guestPort !== guestPort));
}
