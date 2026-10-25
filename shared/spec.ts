import type { IsolationMode, SandboxOverride, SandboxSettings } from "./settings";

export const PROVIDER_ID = "claude-sbx";
export const SPEC_ENV = "PASEO_SBX_SPEC";
export const SPEC_VERSION = 1;

/**
 * Launch contract between the plugin (control plane) and the wrapper (data plane), passed
 * as JSON in `PASEO_SBX_SPEC`. The wrapper treats it as authoritative and never guesses.
 */
export interface SandboxSpec {
  version: typeof SPEC_VERSION;
  name: string;
  key: string;
  /** `XDG_STATE_HOME` of the Paseo-only sbx instance. */
  stateHome: string;
  stateDir: string;
  locksDir: string;
  binDir: string;
  /** Primary mount; the sandbox is created with it first. */
  workspace: string;
  mounts: string[];
  /** sbx `--memory` value. */
  memory: string;
  cpus: number;
  networkAllow: string[];
  forwardPorts: number[];
  env: Record<string, string>;
  claudeConfigDir: string;
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

/** sbx names: letters, digits, hyphens and periods, starting alphanumeric. */
export function sandboxName(key: string, directory: string): string {
  const base = directory.split("/").filter(Boolean).pop() ?? "root";
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "root";
  return `paseo-${slug}-${fnv1a(key)}`;
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

export function memoryMiB(
  settings: Pick<SandboxSettings, "memoryPercent" | "memoryFloorGiB">,
  override: SandboxOverride | undefined,
  hostMemoryBytes: number,
): number {
  if (override?.memoryGiB) return Math.round(override.memoryGiB * 1024);
  const percent = Math.floor((hostMemoryBytes * settings.memoryPercent) / 100 / 1024 / 1024);
  return Math.max(percent, Math.round(settings.memoryFloorGiB * 1024));
}

export interface MountEntry {
  path: string;
  readOnly: boolean;
}

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
export function mergeMounts(mounts: readonly MountEntry[]): MountEntry[] {
  const byPath = new Map<string, MountEntry>();
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
