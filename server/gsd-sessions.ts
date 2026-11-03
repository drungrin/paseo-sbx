import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gsdPathEnabled, type SandboxSettings } from "../shared/settings";
import { usesGsdPath } from "./gsd-path";
import type { PluginPaths } from "./paths";
import type { SandboxState } from "./state";

/**
 * GSD Path counts usage from host session logs listed in its `daemon.json` (`session_dirs`). A
 * sandbox's Claude writes them under the plugin's state, so the plugin lists them there: the
 * sandboxes' `<config dir>/projects` of repos with the integration on, and the shared Codex home's
 * `sessions`. Its daemon and the GSD Observer re-read the file, so a new sandbox counts at once.
 */

/** GSD Path's own list, which a missing `session_dirs` stands for (`gsd_daemon/sessions.py`). */
export const GSD_DEFAULT_SESSION_DIRS = [
  "~/.codex/sessions",
  "~/Library/Application Support/orca/codex-accounts/*/home/sessions",
  "~/AppData/Roaming/orca/codex-accounts/*/home/sessions",
  "~/.claude/projects",
] as const;

/** A sandbox config dir the plugin has seen, kept after the sandbox is gone: its logs stay on the host. */
export interface GsdSessionSource {
  claudeConfigDir: string;
  repoKey: string;
  workspace: string;
}

interface Ledger {
  sources: GsdSessionSource[];
  /** Folders the plugin added to `session_dirs`; the only ones it ever removes. */
  written: string[];
}

export function gsdDaemonConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.GSD_DAEMON_CONFIG || join(home, ".gsd-path", "daemon.json");
}

function ledgerPath(paths: PluginPaths): string {
  return join(paths.root, "gsd-session-dirs.json");
}

function readLedger(paths: PluginPaths): Ledger {
  try {
    const data = JSON.parse(readFileSync(ledgerPath(paths), "utf8")) as Partial<Ledger>;
    return { sources: Array.isArray(data.sources) ? data.sources : [], written: Array.isArray(data.written) ? data.written : [] };
  } catch {
    return { sources: [], written: [] };
  }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function sameSource(a: GsdSessionSource, b: GsdSessionSource): boolean {
  return a.claudeConfigDir === b.claudeConfigDir && a.repoKey === b.repoKey && a.workspace === b.workspace;
}

/** Records a working sandbox's config dir; true when it was new. */
export function rememberGsdSessionSource(paths: PluginPaths, source: GsdSessionSource): boolean {
  const ledger = readLedger(paths);
  if (ledger.sources.some((known) => sameSource(known, source))) return false;
  const sources = [...ledger.sources.filter((known) => known.claudeConfigDir !== source.claudeConfigDir), source];
  writeAtomic(ledgerPath(paths), `${JSON.stringify({ ...ledger, sources }, null, 2)}\n`);
  return true;
}

/** Working sandboxes in the state dir; template preparations and records without a config dir are left out. */
function stateSources(paths: PluginPaths): GsdSessionSource[] {
  let names: string[];
  try {
    names = readdirSync(paths.stateDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const sources: GsdSessionSource[] = [];
  for (const name of names) {
    let state: SandboxState;
    try {
      state = JSON.parse(readFileSync(join(paths.stateDir, name), "utf8")) as SandboxState;
    } catch {
      continue;
    }
    if (state.kind === "template-prep" || !state.claudeConfigDir || !state.repoKey || !state.workspace) continue;
    sources.push({ claudeConfigDir: state.claudeConfigDir, repoKey: state.repoKey, workspace: state.workspace });
  }
  return sources;
}

/** The session folders that should be listed, created so GSD Path finds them before the first log. */
function wantedFolders(paths: PluginPaths, settings: SandboxSettings, sources: readonly GsdSessionSource[]): string[] {
  const wanted: string[] = [];
  for (const source of sources) {
    if (!gsdPathEnabled(settings, source.repoKey) || !usesGsdPath(source.workspace)) continue;
    if (!existsSync(source.claudeConfigDir)) continue;
    const folder = join(source.claudeConfigDir, "projects");
    if (!wanted.includes(folder)) wanted.push(folder);
  }
  // Codex's home is shared by every sandbox; its sessions are told apart by their cwd.
  if (wanted.length > 0 && settings.enabledAgents.includes("codex")) wanted.push(join(paths.homesDir, "codex", "sessions"));
  for (const folder of wanted) mkdirSync(folder, { recursive: true });
  return wanted;
}

/** JSON with sorted keys and two-space indents, as GSD Path saves its config. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export type GsdSessionsResult =
  | { status: "updated" | "unchanged"; configPath: string; folders: string[] }
  | { status: "no-config" | "invalid-config"; configPath: string; folders: string[]; error?: string };

/**
 * Brings `session_dirs` to the wanted folders: adds the missing ones and removes only folders the
 * plugin added that are no longer wanted. Your own entries keep their place. Nothing is written
 * without a GSD Path config, or when the list already matches.
 */
export function reconcileGsdSessionDirs(
  paths: PluginPaths,
  settings: SandboxSettings,
  configPath = gsdDaemonConfigPath(),
): GsdSessionsResult {
  const ledger = readLedger(paths);
  const sources = [...ledger.sources];
  for (const source of stateSources(paths)) {
    if (!sources.some((known) => sameSource(known, source))) sources.push(source);
  }
  const folders = wantedFolders(paths, settings, sources);
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return { status: "no-config", configPath, folders };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { status: "invalid-config", configPath, folders, error: error instanceof Error ? error.message : String(error) };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { status: "invalid-config", configPath, folders, error: "not a JSON object" };
  }
  const config = data as Record<string, unknown>;
  const stored = config.session_dirs;
  const current =
    Array.isArray(stored) && stored.every((item) => typeof item === "string")
      ? (stored as string[])
      : [...GSD_DEFAULT_SESSION_DIRS];
  const kept = current.filter((item) => !ledger.written.includes(item) || folders.includes(item));
  const added = folders.filter((folder) => !kept.includes(folder));
  const next = [...kept, ...added];
  const written = [...ledger.written.filter((item) => folders.includes(item) && next.includes(item)), ...added];
  // A missing list stays missing until there is something to add: it means GSD Path's defaults.
  const changed = Array.isArray(stored)
    ? next.length !== current.length || next.some((item, index) => item !== current[index])
    : added.length > 0;
  if (changed) writeAtomic(configPath, `${JSON.stringify(sortKeys({ ...config, session_dirs: next }), null, 2)}\n`);
  if (written.length !== ledger.written.length || written.some((item, index) => item !== ledger.written[index]) || sources.length !== ledger.sources.length) {
    writeAtomic(ledgerPath(paths), `${JSON.stringify({ sources, written }, null, 2)}\n`);
  }
  return { status: changed ? "updated" : "unchanged", configPath, folders };
}

/** The settings that decide the folders, to apply a settings change only when it touches them. */
export function gsdSessionsKey(settings: SandboxSettings): string {
  const repos = Object.entries(settings.repos)
    .filter(([, repo]) => repo.gsdPath !== undefined)
    .map(([key, repo]) => [key, repo.gsdPath])
    .sort();
  return JSON.stringify([settings.gsdPath, settings.enabledAgents.includes("codex"), repos]);
}

export type GsdSessionsStatus = "listed" | "not-listed" | "no-config" | "invalid-config";

/** Whether GSD Path's config lists a session folder, for the panel. */
export function gsdSessionsStatus(folder: string, configPath = gsdDaemonConfigPath()): GsdSessionsStatus {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return "no-config";
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "invalid-config";
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return "invalid-config";
  const stored = (data as Record<string, unknown>).session_dirs;
  return Array.isArray(stored) && stored.includes(folder) ? "listed" : "not-listed";
}
