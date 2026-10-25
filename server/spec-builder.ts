import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import type { SandboxSettings } from "../shared/settings";
import {
  SPEC_VERSION,
  formatMount,
  isWithin,
  memoryMiB,
  mergeMounts,
  parseEnvFile,
  parseMount,
  sandboxIdentity,
  type MountEntry,
  type SandboxSpec,
} from "../shared/spec";
import type { PluginPaths } from "./paths";

export interface SpecInput {
  settings: SandboxSettings;
  workspaceId: string | null;
  cwd: string;
  paths: PluginPaths;
  env?: NodeJS.ProcessEnv;
  home?: string;
  hostMemoryBytes?: number;
}

export interface BuiltSpec {
  spec: SandboxSpec;
  /** Configured variables with no value in the env file or the daemon environment. */
  missingEnv: string[];
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 10_000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

/** The workspace root is the git toplevel of the agent cwd, or the cwd outside git. */
export async function workspaceDirectory(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])) ?? cwd;
}

/** A worktree's git metadata lives in the main checkout; it must be mounted writable. */
async function gitCommonDir(cwd: string): Promise<string | null> {
  return git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

export function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function forwardedEnvNames(settings: SandboxSettings, key: string): string[] {
  return [...new Set([...settings.envNames, ...(settings.overrides[key]?.envNames ?? [])])];
}

/**
 * Per-sandbox Claude config dir: writable state (`.claude.json`, transcripts) stays separate per
 * sandbox, while the shared items are symlinks into the host config dir mounted read-only.
 * Paseo reads transcripts through the session's CLAUDE_CONFIG_DIR, so rewind keeps working.
 */
export function prepareClaudeConfigDir(dir: string, hostClaudeDir: string, shared: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const item of shared) {
    const source = join(hostClaudeDir, item);
    const target = join(dir, item);
    if (!existsSync(source)) continue;
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(target);
    } catch {
      stat = null;
    }
    if (stat === null) {
      symlinkSync(source, target);
    } else if (stat.isSymbolicLink() && readlinkSync(target) !== source) {
      unlinkSync(target);
      symlinkSync(source, target);
    }
  }
}

export async function buildSpec(input: SpecInput): Promise<BuiltSpec> {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const { settings, paths } = input;
  const directory = await workspaceDirectory(input.cwd);
  const identity = sandboxIdentity(settings.isolation, input.workspaceId, directory);
  const override = settings.overrides[identity.key];

  const requested: MountEntry[] = [];
  for (const entry of [...settings.mounts, ...(override?.mounts ?? [])]) {
    const mount = parseMount(entry, home);
    if (mount) requested.push(mount);
  }
  const commonDir = await gitCommonDir(input.cwd);
  if (commonDir && !isWithin(commonDir, directory)) requested.push({ path: commonDir, readOnly: false });
  if (settings.claudeShared.length > 0) requested.push({ path: paths.hostClaudeDir, readOnly: true });
  const mounts = mergeMounts(requested)
    .filter((mount) => !isWithin(mount.path, directory))
    .map(formatMount);

  const claudeConfigDir = join(paths.claudeConfigs, identity.name);
  prepareClaudeConfigDir(claudeConfigDir, paths.hostClaudeDir, settings.claudeShared);

  const fileValues = readEnvFile(settings.envFile || paths.defaultEnvFile);
  const forwarded: Record<string, string> = {};
  const missingEnv: string[] = [];
  for (const name of forwardedEnvNames(settings, identity.key)) {
    const value = fileValues[name] ?? env[name];
    if (value === undefined) missingEnv.push(name);
    else forwarded[name] = value;
  }

  const spec: SandboxSpec = {
    version: SPEC_VERSION,
    name: identity.name,
    key: identity.key,
    stateHome: paths.stateHome,
    stateDir: paths.stateDir,
    locksDir: paths.locksDir,
    binDir: paths.binDir,
    workspace: directory,
    mounts,
    memory: `${memoryMiB(settings, override, input.hostMemoryBytes ?? totalmem())}m`,
    cpus: settings.cpus,
    networkAllow: settings.networkAllow,
    forwardPorts: settings.forwardPorts,
    env: forwarded,
    claudeConfigDir,
  };
  return { spec, missingEnv };
}
