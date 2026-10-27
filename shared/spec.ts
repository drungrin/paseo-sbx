import { AGENTS, type AgentId } from "./agents";
import type { IsolationMode, RepoConfig, SandboxSettings } from "./settings";

export const PROVIDER_ID = AGENTS.claude.providerId;
export const SPEC_ENV = "PASEO_SBX_SPEC";
export const SPEC_VERSION = 3;

/**
 * Launch contract between the plugin (control plane) and the wrapper (data plane), passed
 * as JSON in `PASEO_SBX_SPEC`. The wrapper treats it as authoritative and never guesses.
 */
export interface SandboxSpec {
  version: typeof SPEC_VERSION;
  /** The agent this session runs, its CLI on the guest's PATH, and the cwd it works in. */
  agent: AgentId;
  binary: string;
  /** sbx kit that creates the sandbox when no template names one (the agent's). */
  kit: string;
  agentCwd: string;
  /** The agent's shared home and the variable naming it (`sharedHome` of the agent), or null. */
  agentHome: { env: string; path: string } | null;
  /** Parent of every agent's shared home, mounted in sandboxes created since agents share homes. */
  homesDir: string;
  name: string;
  key: string;
  /** Repository the sandbox's settings come from (`repoKey()`), recorded at creation. */
  repoKey: string;
  /** sbx template reference to create the sandbox from; null uses sbx's image for Claude. */
  template: string | null;
  /** `XDG_STATE_HOME` of the Paseo-only sbx instance. */
  stateHome: string;
  stateDir: string;
  locksDir: string;
  /** Private (0700) dir for per-session env files; never mounted into a sandbox. */
  runDir: string;
  binDir: string;
  /** Primary mount; the sandbox is created with it first. */
  workspace: string;
  mounts: string[];
  /**
   * Mounts under the host home that also appear in the guest's home: `target`, the mounted host
   * path, is bind-mounted at `name` relative to it. Tools that look in `~` find them there.
   */
  homeMounts: HomeMount[];
  /** sbx `--memory` value. */
  memory: string;
  cpus: number;
  /** `/var/lib/docker` size at creation (`DOCKER_SANDBOXES_DOCKER_SIZE`); null uses sbx's. */
  dockerDisk: string | null;
  networkAllow: string[];
  forwardPorts: number[];
  /** Guest ports of the repository published on ephemeral host ports at every launch. */
  autoPublish: number[];
  env: Record<string, string>;
  claudeConfigDir: string;
}

export interface HomeMount {
  name: string;
  target: string;
}

export interface SandboxIdentity {
  key: string;
  name: string;
}

/** Sandbox an agent was first opened in; later opens reuse it even if settings changed. */
export interface SandboxBinding extends SandboxIdentity {
  claudeConfigDir: string;
}

const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
]);

/** Variables the host-side sbx client reads itself; forwarding them would redirect it. */
export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV.has(name) || name.startsWith("SBX_") || name.startsWith("DOCKER_");
}

export function sandboxKey(
  isolation: IsolationMode,
  workspaceId: string | null,
  directory: string,
): string {
  return isolation === "workspace" && workspaceId
    ? `workspace:${workspaceId}`
    : `directory:${directory}`;
}

function slug(directory: string): string {
  const base = directory.split("/").filter(Boolean).pop() ?? "root";
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "root"
  );
}

/** sbx names: letters, digits, hyphens and periods, starting alphanumeric. */
export function sandboxName(key: string, directory: string): string {
  return `paseo-${slug(directory)}-${fnv1a(key)}`;
}

/** The sandbox a repo's template is prepared in: one per repo, reused until saved or discarded. */
export function templatePrepName(repoKey: string, root: string): string {
  return `paseo-tpl-${slug(root)}-${fnv1a(`template:${repoKey}`)}`;
}

/**
 * An agent's catalog sandbox. sbx keeps network policies per sandbox name for every instance of
 * the user, so the name carries the instance (its state home).
 */
export function catalogName(agent: string, stateHome: string): string {
  return `paseo-catalog-${agent}-${fnv1a(`catalog:${stateHome}`)}`;
}

/** Tags `template save` accepts here: `name`, `name:tag` or `namespace/name:tag`. */
export const TEMPLATE_TAG_PATTERN = /^[a-z0-9._-]+(\/[a-z0-9._-]+)?(:[A-Za-z0-9._-]+)?$/;

/** The full reference `sbx template ls` reports for a short one (`name:tag` → `docker.io/library/name:tag`). */
export function normalizeTemplateRef(ref: string): string {
  const withTag = /:[^/]+$/.test(ref) ? ref : `${ref}:latest`;
  const parts = withTag.split("/");
  if (parts.length === 1) return `docker.io/library/${withTag}`;
  const first = parts[0];
  const isRegistry = first.includes(".") || first.includes(":") || first === "localhost";
  return isRegistry ? withTag : `docker.io/${withTag}`;
}

export function sandboxIdentity(
  isolation: IsolationMode,
  workspaceId: string | null,
  directory: string,
): SandboxIdentity {
  const key = sandboxKey(isolation, workspaceId, directory);
  return { key, name: sandboxName(key, directory) };
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** sbx accepts 512 MiB up to 75% of host memory. */
export function memoryLimitsMiB(hostMemoryBytes: number): { min: number; max: number } {
  return { min: 512, max: Math.max(512, Math.floor((hostMemoryBytes * 0.75) / 1024 / 1024)) };
}

export function memoryMiB(
  settings: Pick<SandboxSettings, "memoryPercent" | "memoryFloorGiB">,
  repo: Pick<RepoConfig, "memoryGiB"> | undefined,
  hostMemoryBytes: number,
): number {
  const requested = repo?.memoryGiB
    ? Math.round(repo.memoryGiB * 1024)
    : Math.max(
        Math.floor((hostMemoryBytes * settings.memoryPercent) / 100 / 1024 / 1024),
        Math.round(settings.memoryFloorGiB * 1024),
      );
  const { min, max } = memoryLimitsMiB(hostMemoryBytes);
  return Math.min(Math.max(requested, min), max);
}

export interface MountEntry {
  path: string;
  readOnly: boolean;
}

/** Why a sandbox mounts a path; the workspace panel shows it. */
export const MOUNT_SOURCES = ["settings", "repo", "gsd-path", "member", "git", "claude", "agents"] as const;
export type MountSource = (typeof MOUNT_SOURCES)[number];

/** Parses `path` or `path:ro`, expanding a leading `~/`. Returns null for relative paths. */
export function parseMount(entry: string, home: string): MountEntry | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const readOnly = trimmed.endsWith(":ro");
  let path = readOnly ? trimmed.slice(0, -3) : trimmed;
  if (path === "~") path = home;
  else if (path.startsWith("~/")) path = `${home}/${path.slice(2)}`;
  if (!path.startsWith("/")) return null;
  path = path.replace(/\/+$/, "") || "/";
  return { path, readOnly };
}

export function formatMount(mount: MountEntry): string {
  return mount.readOnly ? `${mount.path}:ro` : mount.path;
}

/** Dedupes by path; a writable entry wins over a read-only one for the same path. */
export function mergeMounts<Mount extends MountEntry>(mounts: readonly Mount[]): Mount[] {
  const byPath = new Map<string, Mount>();
  for (const mount of mounts) {
    const existing = byPath.get(mount.path);
    if (!existing || (existing.readOnly && !mount.readOnly)) byPath.set(mount.path, mount);
  }
  return [...byPath.values()];
}

export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function isExcluded(cwd: string, excludedPaths: readonly string[], home: string): boolean {
  return excludedPaths.some((entry) => {
    const parsed = parseMount(entry, home);
    return parsed !== null && isWithin(cwd, parsed.path);
  });
}

/** dotenv subset: `KEY=value`, optional `export `, `#` comments, single or double quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/** Entries `parseMount` drops: neither absolute nor under `~/`. */
export function invalidMounts(entries: readonly string[]): string[] {
  return entries.filter((entry) => parseMount(entry, "/") === null);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names that are not variable names, or that sbx keeps for itself. */
export function invalidEnvNames(names: readonly string[]): string[] {
  return names.filter((name) => !ENV_NAME.test(name) || isReservedEnvName(name));
}

export function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parsePortList(text: string): number[] {
  return parseList(text)
    .map((item) => Number(item))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}
