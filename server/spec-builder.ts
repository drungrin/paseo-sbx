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
import { join, relative } from "node:path";
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
  type HomeLink,
  type MountEntry,
  type MountSource,
  type SandboxBinding,
  type SandboxSpec,
} from "../shared/spec";
import { canonical, git } from "./git";
import { gsdPathMembers, usesGsdPath, type GsdPathMember } from "./gsd-path";
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

export interface SourcedMount extends MountEntry {
  source: MountSource;
}

export interface BuiltSpec {
  spec: SandboxSpec;
  /** `spec.mounts` with where each comes from. */
  mounts: SourcedMount[];
  /** Null when the workspace does not use GSD Path. */
  gsdPath: { enabled: boolean; members: GsdPathMember[] } | null;
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

/** Mounts you chose, which tools may look for in `~`; checkouts and Claude's config are reached by path. */
const LINKED_SOURCES: ReadonlySet<MountSource> = new Set(["settings", "repo", "gsd-path"]);

export async function buildSpec(input: SpecInput): Promise<BuiltSpec> {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const { settings, paths } = input;
  const directory = await workspaceDirectory(input.cwd);
  const identity = input.binding ?? sandboxIdentity(settings.isolation, input.workspaceId, directory);
  // An existing sandbox keeps the repo it was created for, whatever cwd a session opens with.
  const repoKey = readSandboxState(paths, identity.name)?.repoKey ?? (await repoIdentity(input.cwd)).key;
  const repo = settings.repos[repoKey];

  const requested: SourcedMount[] = [];
  const add = (entries: readonly string[], source: MountSource) => {
    for (const entry of entries) {
      const mount = parseMount(entry, home);
      if (mount) requested.push({ ...mount, source });
    }
  };
  add(settings.mounts, "settings");
  add(repo?.mounts ?? [], "repo");
  // A coordinator's agents work in its member checkouts and in worktrees under ~/.gsd-path, where
  // the GSD Path runtime lives too. The guest's home links to it, since the runtime looks in `~`.
  const gsdPath = usesGsdPath(directory) ? { enabled: settings.gsdPath, members: gsdPathMembers(directory, home) } : null;
  if (gsdPath?.enabled) {
    requested.push({ path: join(home, ".gsd-path"), readOnly: false, source: "gsd-path" });
    for (const member of gsdPath.members) {
      requested.push({ path: member.path, readOnly: false, source: "member" });
      const memberCommonDir = existsSync(member.path) ? await gitCommonDir(member.path) : null;
      if (memberCommonDir && !isWithin(memberCommonDir, member.path)) {
        requested.push({ path: memberCommonDir, readOnly: false, source: "git" });
      }
    }
  }
  const commonDir = await gitCommonDir(input.cwd);
  if (commonDir && !isWithin(commonDir, directory)) requested.push({ path: commonDir, readOnly: false, source: "git" });
  if (settings.claudeShared.length > 0) requested.push({ path: paths.hostClaudeDir, readOnly: true, source: "claude" });
  const sourced = mergeMounts(requested).filter((mount) => !isWithin(mount.path, directory));
  const mounts = sourced.map(formatMount);
  const homeLinks: HomeLink[] = sourced
    .filter((mount) => LINKED_SOURCES.has(mount.source) && mount.path !== home && isWithin(mount.path, home))
    .map((mount) => ({ name: relative(home, mount.path), target: mount.path }));

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
    homeLinks,
    memory: `${memoryMiB(settings, repo, input.hostMemoryBytes ?? totalmem())}m`,
    cpus: settings.cpus,
    networkAllow: settings.networkAllow,
    forwardPorts: settings.forwardPorts,
    autoPublish: repo?.autoPublish ?? [],
    env: forwarded,
    claudeConfigDir,
  };
  return { spec, mounts: sourced, gsdPath, missingEnv, rejectedEnv };
}
