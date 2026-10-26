import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import type { SandboxSettings } from "../shared/settings";
import {
  SPEC_VERSION,
  formatMount,
  isReservedEnvName,
  isWithin,
  memoryMiB,
  mergeMounts,
  parseEnvFile,
  parseMount,
  sandboxIdentity,
  type MountEntry,
  type SandboxBinding,
  type SandboxSpec,
} from "../shared/spec";
import { canonical, git } from "./git";
import type { PluginPaths } from "./paths";
import { repoIdentity } from "./repo";
import { readSandboxState } from "./state";

export interface SpecInput {
  settings: SandboxSettings;
  workspaceId: string | null;
  cwd: string;
  paths: PluginPaths;
  /** Reuses an agent's original sandbox instead of deriving one from current settings. */
  binding?: SandboxBinding | null;
  env?: NodeJS.ProcessEnv;
  home?: string;
  hostMemoryBytes?: number;
  /** Creates and links the sandbox's Claude config dir. Off for read-only callers. */
  prepare?: boolean;
}

export interface BuiltSpec {
  spec: SandboxSpec;
  /** Configured variables with no value in the env file or the daemon environment. */
  missingEnv: string[];
  /** Configured variables the sbx client reserves for itself, never forwarded. */
  rejectedEnv: string[];
}

/** The workspace root is the git toplevel of the agent cwd, or the canonical cwd outside git. */
export async function workspaceDirectory(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])) ?? canonical(cwd);
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

export function forwardedEnvNames(settings: SandboxSettings, repoKey: string): string[] {
  return [...new Set([...settings.envNames, ...(settings.repos[repoKey]?.envNames ?? [])])];
}

/** The repo's template, else the global default; null uses sbx's image for Claude. */
export function templateFor(settings: SandboxSettings, repoKey: string): string | null {
  return settings.repos[repoKey]?.template || settings.template || null;
}

/**
 * Per-sandbox Claude config dir: writable state (`.claude.json`, transcripts) stays separate per
 * sandbox, while the shared items are symlinks into the host config dir mounted read-only.
 * Paseo reads transcripts through the session's CLAUDE_CONFIG_DIR, so rewind keeps working.
 */
export function prepareClaudeConfigDir(dir: string, hostClaudeDir: string, shared: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  const wanted = new Set(shared);
  for (const entry of readdirSync(dir)) {
    const target = join(dir, entry);
    if (wanted.has(entry) || !lstatSync(target).isSymbolicLink()) continue;
    // Drop links to host items no longer shared; leave anything Claude wrote.
    if (isWithin(readlinkSync(target), hostClaudeDir)) unlinkSync(target);
  }
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
    } else if (stat.isSymbolicLink()) {
      if (readlinkSync(target) !== source) {
        unlinkSync(target);
        symlinkSync(source, target);
      }
    } else {
      console.warn(`[paseo-sbx] ${target} is a local copy and hides the shared ${source}`);
    }
  }
}

/** Claude Code's transcript dir name for a project path (same encoding as Paseo's lookup). */
export function claudeProjectDirName(projectPath: string): string {
  const replaced = projectPath.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= 200) return replaced;
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash + projectPath.charCodeAt(i)) | 0;
  }
  return `${replaced.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Importable sessions are listed from the host Claude config dir, but the import resumes the
 * session under the sandbox's own config dir: copy the project's transcripts across first.
 */
export function copyHostTranscripts(hostClaudeDir: string, cwd: string, claudeConfigDir: string): void {
  const name = claudeProjectDirName(canonical(cwd));
  const source = join(hostClaudeDir, "projects", name);
  if (!existsSync(source)) return;
  cpSync(source, join(claudeConfigDir, "projects", name), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

export async function buildSpec(input: SpecInput): Promise<BuiltSpec> {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const { settings, paths } = input;
  const directory = await workspaceDirectory(input.cwd);
  const identity = input.binding ?? sandboxIdentity(settings.isolation, input.workspaceId, directory);
  // An existing sandbox keeps the repo it was created for, whatever cwd a session opens with.
  const repoKey = readSandboxState(paths, identity.name)?.repoKey ?? (await repoIdentity(input.cwd)).key;
  const repo = settings.repos[repoKey];

  const requested: MountEntry[] = [];
  for (const entry of [...settings.mounts, ...(repo?.mounts ?? [])]) {
    const mount = parseMount(entry, home);
    if (mount) requested.push(mount);
  }
  const commonDir = await gitCommonDir(input.cwd);
  if (commonDir && !isWithin(commonDir, directory)) requested.push({ path: commonDir, readOnly: false });
  if (settings.claudeShared.length > 0) requested.push({ path: paths.hostClaudeDir, readOnly: true });
  const mounts = mergeMounts(requested)
    .filter((mount) => !isWithin(mount.path, directory))
    .map(formatMount);

  const claudeConfigDir = input.binding?.claudeConfigDir ?? join(paths.claudeConfigs, identity.name);
  if (input.prepare !== false) prepareClaudeConfigDir(claudeConfigDir, paths.hostClaudeDir, settings.claudeShared);

  const fileValues = readEnvFile(settings.envFile || paths.defaultEnvFile);
  const forwarded: Record<string, string> = {};
  const missingEnv: string[] = [];
  const rejectedEnv: string[] = [];
  for (const name of forwardedEnvNames(settings, repoKey)) {
    if (isReservedEnvName(name)) {
      rejectedEnv.push(name);
      continue;
    }
    const value = fileValues[name] ?? env[name];
    if (value === undefined) missingEnv.push(name);
    else forwarded[name] = value;
  }

  const spec: SandboxSpec = {
    version: SPEC_VERSION,
    name: identity.name,
    key: identity.key,
    repoKey,
    template: templateFor(settings, repoKey),
    stateHome: paths.stateHome,
    stateDir: paths.stateDir,
    locksDir: paths.locksDir,
    runDir: paths.runDir,
    binDir: paths.binDir,
    workspace: directory,
    mounts,
    memory: `${memoryMiB(settings, repo, input.hostMemoryBytes ?? totalmem())}m`,
    cpus: settings.cpus,
    networkAllow: settings.networkAllow,
    forwardPorts: settings.forwardPorts,
    autoPublish: repo?.autoPublish ?? [],
    env: forwarded,
    claudeConfigDir,
  };
  return { spec, missingEnv, rejectedEnv };
}
