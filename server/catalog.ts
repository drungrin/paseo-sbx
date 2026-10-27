import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, type AgentId } from "../shared/agents";
import type { SandboxSettings } from "../shared/settings";
import { catalogName } from "../shared/spec";
import { newLockToken, withSandboxLock } from "./lock";
import type { PluginPaths } from "./paths";
import { assertImageDownloadsAllowed, listSandboxes, removeSandbox, runSbx, runSbxOk, storedSecrets } from "./sbx";

/**
 * What the wrapper needs to run an agent's catalog, diagnostic, archive and history runs, which
 * Paseo starts without a session: `catalog/<agent>.json`, outside the catalog's own mounts.
 */
export interface CatalogRecord {
  version: 1;
  agent: AgentId;
  name: string;
  stateHome: string;
  runDir: string;
  binDir: string;
  /** The catalog's workspace, its only writable mount besides the agents' shared homes. */
  workdir: string;
  binary: string;
  /** `<binary> --version` in the kit, answered to Paseo without starting the VM. */
  cliVersion: string;
  claudeConfigDir: string | null;
  agentHome: { env: string; path: string } | null;
  /** Your Claude settings, whose env reaches each run through its private env file. */
  hostSettings: string | null;
  /** Host loopback ports the catalog may relay (a gateway's). */
  ports: number[];
  createdAt: string;
}

function recordPath(paths: PluginPaths, agent: AgentId): string {
  return join(paths.catalogDir, `${agent}.json`);
}

export function readCatalog(paths: PluginPaths, agent: AgentId): CatalogRecord | null {
  try {
    return JSON.parse(readFileSync(recordPath(paths, agent), "utf8")) as CatalogRecord;
  } catch {
    return null;
  }
}

function writeCatalog(paths: PluginPaths, record: CatalogRecord): void {
  mkdirSync(paths.catalogDir, { recursive: true });
  const file = recordPath(paths, record.agent);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ACCESS_KEY|PRIVATE_KEY)/i;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The settings Claude reads in the catalog: yours without `env` (a gateway's token lives there)
 * and without `apiKeyHelper`. The run gets the env through its private env file instead, so no
 * credential sits on the catalog's disk.
 */
export function catalogClaudeSettings(hostSettings: Record<string, unknown> | null): Record<string, unknown> {
  const { env: _env, apiKeyHelper: _helper, ...rest } = hostSettings ?? {};
  return rest;
}

function loopbackPorts(values: readonly string[]): number[] {
  const ports = new Set<number>();
  for (const value of values) {
    for (const match of value.matchAll(/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/g)) ports.add(Number(match[1]));
  }
  return [...ports].filter((port) => port > 0 && port < 65536).sort((a, b) => a - b);
}

export interface CatalogStatus {
  name: string;
  record: CatalogRecord | null;
  exists: boolean;
  /** The service secret the agent signs in with, and whether one applies to the catalog. */
  login: { service: string; stored: boolean };
}

export async function catalogStatus(paths: PluginPaths, agent: AgentId): Promise<CatalogStatus> {
  const name = catalogName(agent, paths.stateHome);
  const [sandboxes, secrets] = await Promise.all([listSandboxes(paths), storedSecrets(paths).catch(() => [])]);
  const service = AGENTS[agent].secretService;
  return {
    name,
    record: readCatalog(paths, agent),
    exists: sandboxes.some((sandbox) => sandbox.name === name),
    login: { service, stored: secrets.some((s) => s.service === service && (s.scope === "global" || s.scope === name)) },
  };
}

/**
 * Creates (or, with `update`, recreates from a freshly pulled kit) the agent's catalog sandbox:
 * no workspace of yours, the agents' shared homes, the plugin's helpers read-only. Then takes over
 * what the kit wrote for signing in, and records the CLI's version.
 */
export async function ensureCatalog(
  paths: PluginPaths,
  settings: SandboxSettings,
  agent: AgentId,
  options: { update: boolean },
): Promise<CatalogRecord> {
  const descriptor = AGENTS[agent];
  const name = catalogName(agent, paths.stateHome);
  return withSandboxLock(paths, name, newLockToken(), async () => {
    const exists = (await listSandboxes(paths)).some((sandbox) => sandbox.name === name);
    if (exists && !options.update) {
      const record = readCatalog(paths, agent);
      if (record) return record;
    }
    // Before an update removes the catalog it has.
    assertImageDownloadsAllowed(settings, `Setting up the ${descriptor.label} catalog`);
    if (exists) {
      // sbx deletes secrets scoped to a sandbox along with it.
      const scoped = (await storedSecrets(paths, 0)).filter((secret) => secret.scope === name);
      if (scoped.length > 0) {
        throw new Error(
          `${name} has secrets scoped to it (${scoped.map((s) => s.service).join(", ")}) that recreating would delete; store them globally first`,
        );
      }
      await removeSandbox(paths, name);
    }

    const workdir = join(paths.catalogDir, agent);
    mkdirSync(workdir, { recursive: true });
    mkdirSync(paths.homesDir, { recursive: true });
    const agentHome = descriptor.sharedHome
      ? { env: descriptor.sharedHome.env, path: join(paths.homesDir, descriptor.sharedHome.dir) }
      : null;
    if (agentHome) mkdirSync(agentHome.path, { recursive: true });

    let claudeConfigDir: string | null = null;
    let hostSettings: string | null = null;
    let ports: number[] = [];
    if (agent === "claude") {
      hostSettings = join(paths.hostClaudeDir, "settings.json");
      const settingsJson = readJson(hostSettings);
      claudeConfigDir = join(workdir, "claude-config");
      mkdirSync(claudeConfigDir, { recursive: true });
      writeFileSync(join(claudeConfigDir, "settings.json"), `${JSON.stringify(catalogClaudeSettings(settingsJson), null, 2)}\n`);
      const env = settingsJson?.env;
      const values = env !== null && typeof env === "object" ? Object.values(env).filter((v) => typeof v === "string") : [];
      ports = loopbackPorts([...values, ...Object.entries(process.env).filter(([k]) => k.startsWith("ANTHROPIC_")).map(([, v]) => v ?? "")]);
    }

    await runSbxOk(
      paths,
      ["create", "--name", name, "--memory", "1024m", "--no-progress", descriptor.kit, workdir, paths.homesDir, `${paths.binDir}:ro`],
      `sbx create ${name}`,
      900_000,
    );
    const rules = [...settings.networkAllow, ...ports.map((port) => `localhost:${port}`)];
    await runSbxOk(paths, ["policy", "allow", "network", "--sandbox", name, rules.join(",")], "sbx policy allow");

    if (descriptor.sharedHome && agentHome) {
      for (const file of descriptor.kitFiles) {
        const target = join(agentHome.path, file.path);
        if (!file.replace && existsSync(target)) continue;
        const read = await runSbx(paths, ["exec", name, "cat", `/home/agent/${descriptor.sharedHome.kitHome}/${file.path}`]);
        if (read.code !== 0) continue;
        writeFileSync(target, read.stdout, { mode: 0o600 });
        chmodSync(target, 0o600);
      }
    }

    const version = await runSbxOk(paths, ["exec", name, descriptor.binary, "--version"], `${descriptor.binary} --version`);
    const record: CatalogRecord = {
      version: 1,
      agent,
      name,
      stateHome: paths.stateHome,
      runDir: paths.runDir,
      binDir: paths.binDir,
      workdir,
      binary: descriptor.binary,
      cliVersion: version.trim().split("\n")[0] ?? "",
      claudeConfigDir,
      agentHome,
      hostSettings,
      ports,
      createdAt: new Date().toISOString(),
    };
    writeCatalog(paths, record);
    return record;
  });
}
