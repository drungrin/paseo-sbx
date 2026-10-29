import { createHash } from "node:crypto";
import {
  type Stats,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { AGENTS, type AgentId } from "../shared/agents";
import { mcpAutoLoad } from "../shared/mcp";
import { LEGACY_CLAUDE_SHARED, type SandboxSettings } from "../shared/settings";
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
  type HomeMount,
  type MountEntry,
  type MountSource,
  type SandboxBinding,
  type SandboxSpec,
} from "../shared/spec";
import { canonical, git } from "./git";
import { gsdPathMembers, usesGsdPath, type GsdPathMember } from "./gsd-path";
import type { PluginPaths } from "./paths";
import { repoIdentity } from "./repo";
import { secretsFor, type StoredSecret } from "./sbx";
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
  /** The agent the session runs; the plugin's own operations prepare Claude's. */
  agent?: AgentId;
  /** Port of Paseo's daemon, whose MCP server sessions reach on the host's loopback. */
  daemonPort?: number | null;
  /** sbx service secrets (`sbx secret ls`); those applying to the sandbox matter. */
  secrets?: readonly StoredSecret[];
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

/** The variables file, `~/` expanded; empty settings use the plugin's default path. */
export function envFilePath(settings: SandboxSettings, paths: PluginPaths, home = homedir()): string {
  const file = settings.envFile.trim();
  if (!file) return paths.defaultEnvFile;
  return file === "~" || file.startsWith("~/") ? join(home, file.slice(1)) : file;
}

const CLAUDE_LOGIN_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

export interface ClaudeLogin {
  /** Where the login sessions get comes from; null when only the sbx secret could sign in. */
  source: "settings" | "environment" | "unreadable" | null;
  /** The login variables found there (names only). */
  names: string[];
  /** Your Claude settings sign in with an `apiKeyHelper`, which sessions run only from a shared settings.json. */
  helper: boolean;
}

/**
 * How Claude signs in on its own: a key, a gateway token or a cloud provider in the daemon's
 * environment or in your Claude settings' `env` (which every session gets), or an `apiKeyHelper`
 * when your settings.json itself is shared. Unreadable settings count as a login, so the sbx
 * secret never replaces one that works.
 */
export function claudeLogin(env: NodeJS.ProcessEnv, paths: PluginPaths, settingsShared: boolean): ClaudeLogin {
  const fromEnvironment = CLAUDE_LOGIN_VARIABLES.filter((name) => env[name]);
  if (fromEnvironment.length > 0) return { source: "environment", names: fromEnvironment, helper: false };
  let settings: { env?: Record<string, unknown>; apiKeyHelper?: unknown };
  try {
    settings = JSON.parse(readFileSync(join(paths.hostClaudeDir, "settings.json"), "utf8"));
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return { source: missing ? null : "unreadable", names: [], helper: false };
  }
  const names = CLAUDE_LOGIN_VARIABLES.filter((name) => settings.env?.[name]);
  if (typeof settings.env?.ANTHROPIC_BASE_URL === "string" && names.length > 0) names.push("ANTHROPIC_BASE_URL");
  const helper = Boolean(settings.apiKeyHelper);
  if (names.length > 0 || (helper && settingsShared)) return { source: "settings", names, helper };
  return { source: null, names: [], helper };
}

/** Appends an entry to git's config-by-environment list (`GIT_CONFIG_COUNT`, `_KEY_<n>`, `_VALUE_<n>`). */
function addGitConfig(env: Record<string, string>, key: string, value: string): void {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  env[`GIT_CONFIG_KEY_${count}`] = key;
  env[`GIT_CONFIG_VALUE_${count}`] = value;
  env.GIT_CONFIG_COUNT = String(count + 1);
}

export function forwardedEnvNames(settings: SandboxSettings, repoKey: string): string[] {
  return [...new Set([...settings.envNames, ...(settings.repos[repoKey]?.envNames ?? [])])];
}

/** The repo's template, else the global default; null uses sbx's image for Claude. */
export function templateFor(settings: SandboxSettings, repoKey: string): string | null {
  return settings.repos[repoKey]?.template || settings.template || null;
}

const SHARED_COPIES = join(".paseo-sbx", "shared-copies.json");

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Writes through a temp file in the same dir, so Claude never reads half a file. */
function writeAtomic(path: string, data: Buffer | string, mode: number): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, data, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

/**
 * Per-sandbox Claude config dir: writable state (`.claude.json`, `settings.json`, transcripts)
 * stays separate per sandbox. Shared folders are symlinks into the host config dir, mounted
 * read-only. Shared files are copied instead, read-only, at every session: a file mount keeps the
 * inode it started with, and Claude (or an editor) saving a file by renaming a new one over it
 * leaves the sandbox with an unreadable mount until it restarts. The record of what was copied
 * tells the plugin's copies from files Claude or you put there.
 * Paseo reads transcripts through the session's CLAUDE_CONFIG_DIR, so rewind keeps working.
 */
export function prepareClaudeConfigDir(dir: string, hostClaudeDir: string, shared: readonly string[]): void {
  mkdirSync(join(dir, ".paseo-sbx"), { recursive: true });
  const recordPath = join(dir, SHARED_COPIES);
  let copies: Record<string, string> = {};
  try {
    copies = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    copies = {};
  }
  const before = JSON.stringify(copies);
  const wanted = new Set(shared);
  for (const entry of readdirSync(dir)) {
    if (wanted.has(entry)) continue;
    const target = join(dir, entry);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      // Drop links to host items no longer shared; leave anything Claude wrote.
      if (isWithin(readlinkSync(target), hostClaudeDir)) unlinkSync(target);
    } else if (copies[entry] !== undefined) {
      // A copy of an item no longer shared goes, unless it was edited here: then it is yours.
      if (stat.isFile() && sha256(readFileSync(target)) === copies[entry]) unlinkSync(target);
      delete copies[entry];
    }
  }
  for (const item of shared) {
    const source = join(hostClaudeDir, item);
    const target = join(dir, item);
    let sourceIsDir: boolean;
    try {
      sourceIsDir = statSync(source).isDirectory();
    } catch {
      // Missing on the host: a copy already here stays, so a file being replaced costs nothing.
      if (copies[item] !== undefined) console.warn(`[paseo-sbx] ${source} is missing: ${target} keeps the last copy`);
      continue;
    }
    const stat = lstatOrNull(target);
    if (sourceIsDir) {
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
      continue;
    }
    if (stat !== null && stat.isSymbolicLink() && !isWithin(readlinkSync(target), hostClaudeDir)) {
      console.warn(`[paseo-sbx] ${target} is a link of yours and hides the shared ${source}`);
      continue;
    }
    if (stat !== null && !stat.isSymbolicLink() && copies[item] === undefined) {
      console.warn(`[paseo-sbx] ${target} is a local copy and hides the shared ${source}`);
      continue;
    }
    const data = readFileSync(source);
    const hash = sha256(data);
    if (stat !== null && !stat.isSymbolicLink()) {
      const current = sha256(readFileSync(target));
      if (current === hash) {
        copies[item] = hash;
        continue;
      }
      if (current !== copies[item]) console.warn(`[paseo-sbx] ${target} was edited in the sandbox: replaced by ${source}`);
    }
    // A link from before copies existed is replaced like a stale copy.
    writeAtomic(target, data, 0o444);
    copies[item] = hash;
  }
  if (JSON.stringify(copies) !== before) writeAtomic(recordPath, `${JSON.stringify(copies, null, 2)}\n`, 0o600);
}

/**
 * Mounts sandboxes created before shared files were copied still carry: each shared file and the
 * file a link of yours points it at. Nothing reads them any more, so they need no recreation.
 */
export function retiredClaudeFileMounts(hostClaudeDir: string, shared: readonly string[]): Set<string> {
  const retired = new Set<string>();
  for (const item of new Set([...LEGACY_CLAUDE_SHARED, ...shared])) {
    const path = join(hostClaudeDir, item);
    if (isDirectory(path)) continue;
    retired.add(path);
    try {
      retired.add(realpathSync(path));
    } catch {
      // gone from the host
    }
  }
  return retired;
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
const HOME_MOUNT_SOURCES: ReadonlySet<MountSource> = new Set(["settings", "repo", "gsd-path"]);

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
  // the GSD Path runtime lives too. It also appears in the guest's home, where the runtime looks.
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
  // Each shared Claude folder on its own, never the whole config dir with its credentials. The
  // links in the sandbox's config dir point at these paths; a linked folder also needs its
  // target. Shared files are copied into the config dir instead (prepareClaudeConfigDir).
  for (const item of settings.claudeShared) {
    const shared = join(paths.hostClaudeDir, item);
    if (!isDirectory(shared)) continue;
    requested.push({ path: shared, readOnly: true, source: "claude" });
    const target = realpathSync(shared);
    if (target !== shared) requested.push({ path: target, readOnly: true, source: "claude" });
  }
  requested.push({ path: paths.homesDir, readOnly: false, source: "agents" });
  const sourced = mergeMounts(requested).filter((mount) => !isWithin(mount.path, directory));
  const mounts = sourced.map(formatMount);
  const homeMounts: HomeMount[] = sourced
    .filter((mount) => HOME_MOUNT_SOURCES.has(mount.source) && mount.path !== home && isWithin(mount.path, home))
    .map((mount) => ({ name: relative(home, mount.path), target: mount.path }));

  const claudeConfigDir = input.binding?.claudeConfigDir ?? join(paths.claudeConfigs, identity.name);
  if (input.prepare !== false) prepareClaudeConfigDir(claudeConfigDir, paths.hostClaudeDir, settings.claudeShared);

  const fileValues = readEnvFile(envFilePath(settings, paths, home));
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
  // GSD Path places new worktrees under `~/.gsd-path/projects`, which in the guest is a path your
  // git cannot reach from the host: keep them at the host's.
  const agent = AGENTS[input.agent ?? "claude"];
  const secrets = secretsFor(input.secrets ?? [], identity.name);
  const settingsShared = settings.claudeShared.includes("settings.json");
  if (agent.id === "claude" && secrets.includes(agent.secretService) && claudeLogin(env, paths, settingsShared).source === null) {
    // The sbx proxy swaps this marker for the stored secret.
    forwarded.ANTHROPIC_API_KEY = "proxy-managed";
  }
  if (gsdPath?.enabled && forwarded.GSD_PATH_WORKTREE_ROOT === undefined) {
    forwarded.GSD_PATH_WORKTREE_ROOT = env.GSD_PATH_WORKTREE_ROOT || join(home, ".gsd-path", "projects");
  }
  if (settings.githubHttps) {
    for (const remote of ["git@github.com:", "ssh://git@github.com/"]) {
      addGitConfig(forwarded, "url.https://github.com/.insteadOf", remote);
    }
  }

  const spec: SandboxSpec = {
    version: SPEC_VERSION,
    agent: agent.id,
    binary: agent.binary,
    kit: agent.kit,
    agentCwd: input.cwd,
    agentHome: agent.sharedHome ? { env: agent.sharedHome.env, path: join(paths.homesDir, agent.sharedHome.dir) } : null,
    homesDir: paths.homesDir,
    name: identity.name,
    key: identity.key,
    repoKey,
    template: templateFor(settings, repoKey),
    allowImageDownloads: settings.allowImageDownloads,
    stateHome: paths.stateHome,
    stateDir: paths.stateDir,
    locksDir: paths.locksDir,
    runDir: paths.runDir,
    binDir: paths.binDir,
    workspace: directory,
    mounts,
    homeMounts,
    memory: `${memoryMiB(settings, repo, input.hostMemoryBytes ?? totalmem())}m`,
    cpus: repo?.cpus ?? settings.cpus,
    dockerDisk: settings.dockerDiskGiB > 0 ? `${settings.dockerDiskGiB}g` : null,
    networkAllow: settings.networkAllow,
    forwardPorts: input.daemonPort ? [...new Set([...settings.forwardPorts, input.daemonPort])] : settings.forwardPorts,
    autoPublish: repo?.autoPublish ?? [],
    mcpServers: mcpAutoLoad(settings, repoKey),
    env: forwarded,
    claudeConfigDir,
    hostClaudeSettings: join(paths.hostClaudeDir, "settings.json"),
  };
  return { spec, mounts: sourced, gsdPath, missingEnv, rejectedEnv };
}
