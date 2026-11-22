import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { kitForFlavor, type AgentId } from "../shared/agents";
import {
  CLI_IDS,
  CLI_MANIFEST_VERSION,
  CLI_SHIM_PREFIX,
  CLI_SHIM_UNMOUNTED_EXIT,
  CLI_TOOLS,
  CLI_VERSION_PATTERN,
  cliAvailable,
  cliScope,
  cliSelected,
  type CliArch,
  type CliArtifact,
  type CliId,
  type CliRelease,
  type CliScope,
} from "../shared/cli-tools";
import type { SandboxSettings } from "../shared/settings";
import { normalizeTemplateRef, type HomeMount, type SandboxCli } from "../shared/spec";
import type { PluginPaths } from "./paths";
import { runSbx, runSbxOk } from "./sbx";

/** The guest's home: sbx's sandbox user. */
export const GUEST_HOME = "/home/agent";

/** Architectures a CLI was qualified on in a sandbox; another one is refused until it is. */
export const CLI_QUALIFIED_ARCHES: readonly CliArch[] = ["x64"];

/** Marker each state folder carries, so the guest can tell a bind of it from anything else. */
const STATE_MARKER = ".paseo-sbx-cli";

export interface CliDirs {
  /** Every CLI version, `tools/<cli>/<version>/`, and `installed.json`: inside the read-only bin dir. */
  tools: string;
  /** Shims and manifests, `cli/<sandbox>/<generation>/`: inside the read-only bin dir too. */
  shims: string;
  /** Credentials: `global/` mounted in the sandboxes of repositories that share them. */
  auth: string;
  authGlobal: string;
}

export function cliDirs(paths: PluginPaths): CliDirs {
  return {
    tools: join(paths.binDir, "tools"),
    shims: join(paths.binDir, "cli"),
    auth: join(paths.root, "cli-auth"),
    authGlobal: join(paths.root, "cli-auth", "global"),
  };
}

/** A sandbox's own state for its additional CLIs, in its Claude config dir (mounted only there). */
export function cliStateRoot(claudeConfigDir: string): string {
  return join(claudeConfigDir, ".paseo-sbx", "cli");
}

// --- installed versions ------------------------------------------------------------

export interface InstalledCli {
  version: string;
  installedAt: number;
}

type InstalledRecord = Partial<Record<CliId, InstalledCli>>;

function installedFile(dirs: CliDirs): string {
  return join(dirs.tools, "installed.json");
}

export function readInstalled(paths: PluginPaths): InstalledRecord {
  try {
    const parsed = JSON.parse(readFileSync(installedFile(cliDirs(paths)), "utf8")) as InstalledRecord;
    const record: InstalledRecord = {};
    for (const id of CLI_IDS) {
      const entry = parsed[id];
      if (entry && typeof entry.version === "string" && CLI_VERSION_PATTERN.test(entry.version)) record[id] = entry;
    }
    return record;
  } catch {
    return {};
  }
}

function writeInstalled(paths: PluginPaths, record: InstalledRecord): void {
  const file = installedFile(cliDirs(paths));
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, file);
}

/** The executable of an installed version. */
export function cliEntry(paths: PluginPaths, id: CliId, version: string): string {
  return join(cliDirs(paths).tools, id, version, CLI_TOOLS[id].entry);
}

/** Versions on disk, newest folder first. */
export function installedVersions(paths: PluginPaths, id: CliId): string[] {
  const dir = join(cliDirs(paths).tools, id);
  try {
    return readdirSync(dir)
      .filter((name) => CLI_VERSION_PATTERN.test(name) && existsSync(join(dir, name, CLI_TOOLS[id].entry)))
      .sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  } catch {
    return [];
  }
}

// --- downloads -----------------------------------------------------------------------

export type FetchLike = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GETs a URL of one of the CLI's download hosts over HTTPS, following redirects only to those
 * hosts and only over HTTPS. Anything else is refused before it is requested.
 */
async function request(url: string, hosts: readonly string[], fetchImpl: FetchLike, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:" || !hosts.includes(parsed.hostname)) {
      throw new Error(`refusing ${parsed.protocol}//${parsed.hostname}: not one of this CLI's download hosts (HTTPS only)`);
    }
    const response = await fetchImpl(current, { redirect: "manual", signal });
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`${parsed.hostname} redirected without a location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`${parsed.hostname} answered HTTP ${response.status}`);
    return response;
  }
  throw new Error(`too many redirects from ${new URL(url).hostname}`);
}

async function fetchText(url: string, hosts: readonly string[], fetchImpl: FetchLike): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    return await (await request(url, hosts, fetchImpl, controller.signal)).text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, hosts: readonly string[], fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const value = JSON.parse(await fetchText(url, hosts, fetchImpl)) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${new URL(url).hostname} did not answer an object`);
  return value as Record<string, unknown>;
}

/** Streams a download into `file`, hashing it on the way; refuses it unless the digest matches. */
async function downloadVerified(artifact: CliArtifact, hosts: readonly string[], file: string, fetchImpl: FetchLike): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30 * 60_000);
  try {
    const response = await request(artifact.url, hosts, fetchImpl, controller.signal);
    if (!response.body) throw new Error("the download has no body");
    const hash = createHash(artifact.digest.algorithm);
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), tap, createWriteStream(file, { mode: 0o600 }));
    const got = hash.digest("hex");
    if (got !== artifact.digest.hex.toLowerCase()) {
      throw new Error(`the download does not match its ${artifact.digest.algorithm} (expected ${artifact.digest.hex.slice(0, 16)}…, got ${got.slice(0, 16)}…)`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function run(command: string, args: string[], timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) =>
      error ? reject(new Error(`${command} ${args[0]}: ${(stderr || error.message).trim()}`)) : resolve(stdout),
    );
  });
}

/**
 * The tarball's members, checked before anything is extracted: regular files and folders only,
 * relative, with no `..`. A link or a device in the archive refuses the whole download.
 */
export function checkTarListing(names: string[], verbose: string[]): void {
  if (names.length !== verbose.length) throw new Error("the archive's listing is inconsistent");
  names.forEach((name, index) => {
    const type = verbose[index]?.[0];
    if (type !== "-" && type !== "d") throw new Error(`the archive holds a member that is not a file or a folder: ${name}`);
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error(`the archive holds a path outside it: ${name}`);
  });
}

async function extract(id: CliId, artifact: CliArtifact, archive: string, staging: string): Promise<void> {
  const tool = CLI_TOOLS[id];
  if (tool.package.kind === "binary") {
    renameSync(archive, join(staging, tool.entry));
    return;
  }
  const names = (await run("tar", ["-tzf", archive])).split("\n").filter(Boolean);
  const verbose = (await run("tar", ["-tvzf", archive])).split("\n").filter(Boolean);
  checkTarListing(names, verbose);
  const root = artifact.root ? artifact.root.replace(/\/+$/, "") : null;
  const members = root ? [root] : tool.member ? [tool.member] : [];
  if (root && !names.some((name) => name === root || name.startsWith(`${root}/`))) throw new Error(`the archive has no ${root}`);
  if (tool.member && !names.includes(tool.member)) throw new Error(`the archive has no ${tool.member}`);
  const args = ["-xzf", archive, "-C", staging, "--no-same-owner"];
  for (const excluded of tool.package.exclude) args.push(`--exclude=${root ? `${root}/` : ""}${excluded}`);
  if (root) args.push(`--strip-components=${root.split("/").length}`);
  await run("tar", [...args, ...members]);
  if (tool.member && tool.member !== tool.entry) renameSync(join(staging, tool.member), join(staging, tool.entry));
}

export interface InstallStatus {
  installing: boolean;
  /** The version being installed. */
  target: string | null;
  error: string | null;
}

const installs = new Map<CliId, { promise: Promise<void>; target: string }>();
const lastErrors = new Map<CliId, string>();

export function installStatus(id: CliId): InstallStatus {
  const running = installs.get(id);
  return { installing: running !== undefined, target: running?.target ?? null, error: lastErrors.get(id) ?? null };
}

export function cliArch(arch: string = process.arch): CliArch | null {
  return CLI_QUALIFIED_ARCHES.includes(arch as CliArch) ? (arch as CliArch) : null;
}

/**
 * Downloads a release into `tools/<cli>/<version>/` and makes it the active one. Nothing of it
 * runs on the host. One install per CLI at a time; a second call joins the first.
 */
export function installCli(
  paths: PluginPaths,
  id: CliId,
  release: CliRelease = CLI_TOOLS[id].pinned,
  fetchImpl: FetchLike = fetch,
  arch: string = process.arch,
): Promise<void> {
  const running = installs.get(id);
  if (running) return running.promise;
  const promise = (async () => {
    if (!CLI_VERSION_PATTERN.test(release.version)) throw new Error(`${release.version} is not a version`);
    const qualified = cliArch(arch);
    if (!qualified) throw new Error(`no qualified ${CLI_TOOLS[id].label} build for this host's architecture (${arch})`);
    const artifact = release.artifacts[qualified];
    if (!artifact) throw new Error(`${CLI_TOOLS[id].label} ${release.version} has no ${qualified} build`);
    const dirs = cliDirs(paths);
    const target = join(dirs.tools, id, release.version);
    if (!existsSync(join(target, CLI_TOOLS[id].entry))) {
      mkdirSync(join(dirs.tools, id), { recursive: true });
      const staging = join(dirs.tools, id, `.staging-${process.pid}-${randomBytes(4).toString("hex")}`);
      mkdirSync(staging, { recursive: true });
      try {
        const archive = join(staging, ".download");
        await downloadVerified(artifact, CLI_TOOLS[id].downloadHosts, archive, fetchImpl);
        await extract(id, artifact, archive, staging);
        rmSync(archive, { force: true });
        const entry = join(staging, CLI_TOOLS[id].entry);
        if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error(`the download has no ${CLI_TOOLS[id].entry}`);
        chmodSync(entry, 0o755);
        rmSync(target, { recursive: true, force: true });
        renameSync(staging, target);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    writeInstalled(paths, { ...readInstalled(paths), [id]: { version: release.version, installedAt: Date.now() } });
  })()
    .then(() => {
      lastErrors.delete(id);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      lastErrors.set(id, message);
      console.warn(`[paseo-sbx] installing ${CLI_TOOLS[id].label} ${release.version}: ${message}`);
      throw error;
    })
    .finally(() => installs.delete(id));
  installs.set(id, { promise, target: release.version });
  return promise;
}

/** Installs the pinned release of each wanted CLI that has none yet: turning a CLI on is your consent. */
export function syncCliTools(paths: PluginPaths, wanted: readonly CliId[]): void {
  const installed = readInstalled(paths);
  for (const id of wanted) {
    if (installed[id] || installs.has(id) || lastErrors.has(id) || !cliArch()) continue;
    installCli(paths, id).catch(() => undefined);
  }
}

const VENDOR_ARCH: Record<CliArch, { claude: string; npm: string; triple: string; muse: string; agy: string }> = {
  x64: { claude: "linux-x64", npm: "linux-x64", triple: "x86_64-unknown-linux-musl", muse: "x86_linux", agy: "linux_amd64" },
  arm64: { claude: "linux-arm64", npm: "linux-arm64", triple: "aarch64-unknown-linux-musl", muse: "aarch64_linux", agy: "linux_arm64" },
};

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`the vendor's manifest has no ${label}`);
  return value;
}

function hexDigest(value: unknown, algorithm: "sha256" | "sha512", label: string): string {
  const hex = stringField(value, label).toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${algorithm === "sha256" ? 64 : 128}}$`).test(hex)) throw new Error(`the vendor's ${label} is not a ${algorithm}`);
  return hex;
}

function allowedUrl(id: CliId, value: unknown, label: string): string {
  const url = stringField(value, label);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !CLI_TOOLS[id].downloadHosts.includes(parsed.hostname)) {
    throw new Error(`the vendor's ${label} is not on one of this CLI's download hosts`);
  }
  return url;
}

/** The vendor's current release, read from its own manifest: what Update would install. */
export async function latestRelease(id: CliId, fetchImpl: FetchLike = fetch, arch: CliArch = "x64"): Promise<CliRelease> {
  const hosts = CLI_TOOLS[id].downloadHosts;
  const names = VENDOR_ARCH[arch];
  let version: string;
  let artifact: CliArtifact;
  if (id === "claude") {
    const base = "https://downloads.claude.ai/claude-code-releases";
    version = (await fetchText(`${base}/latest`, hosts, fetchImpl)).trim();
    if (!CLI_VERSION_PATTERN.test(version)) throw new Error(`the vendor's latest version is not one: ${version.slice(0, 40)}`);
    const manifest = await fetchJson(`${base}/${version}/manifest.json`, hosts, fetchImpl);
    const platform = (manifest.platforms as Record<string, Record<string, unknown>> | undefined)?.[names.claude];
    artifact = { url: `${base}/${version}/${names.claude}/claude`, digest: { algorithm: "sha256", hex: hexDigest(platform?.checksum, "sha256", "checksum") } };
  } else if (id === "codex") {
    const base = "https://registry.npmjs.org/@openai/codex";
    version = stringField((await fetchJson(`${base}/latest`, hosts, fetchImpl)).version, "version");
    if (!CLI_VERSION_PATTERN.test(version)) throw new Error(`the vendor's latest version is not one: ${version.slice(0, 40)}`);
    const dist = (await fetchJson(`${base}/${version}-${names.npm}`, hosts, fetchImpl)).dist as Record<string, unknown> | undefined;
    const integrity = stringField(dist?.integrity, "integrity");
    if (!integrity.startsWith("sha512-")) throw new Error("the vendor's integrity is not a sha512");
    artifact = {
      url: allowedUrl(id, dist?.tarball, "tarball"),
      digest: { algorithm: "sha512", hex: Buffer.from(integrity.slice(7), "base64").toString("hex") },
      root: `package/vendor/${names.triple}`,
    };
  } else if (id === "muse") {
    const channel = await fetchJson("https://api.meta.ai/muse-code/channels/muse-stable", hosts, fetchImpl);
    version = stringField(channel.version, "version");
    if (!CLI_VERSION_PATTERN.test(version)) throw new Error(`the vendor's latest version is not one: ${version.slice(0, 40)}`);
    const manifest = await fetchJson(allowedUrl(id, channel.manifest_url, "manifest"), hosts, fetchImpl);
    if (manifest.version !== version || (manifest.checksum_algorithm ?? "sha256") !== "sha256") throw new Error("the vendor's manifest does not match its channel");
    const entry = (manifest.artifacts as Record<string, Record<string, unknown>> | undefined)?.[names.muse];
    artifact = { url: allowedUrl(id, entry?.url, "artifact"), digest: { algorithm: "sha256", hex: hexDigest(entry?.checksum, "sha256", "checksum") } };
  } else {
    const manifest = await fetchJson(`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${names.agy}.json`, hosts, fetchImpl);
    version = stringField(manifest.version, "version");
    if (!CLI_VERSION_PATTERN.test(version)) throw new Error(`the vendor's latest version is not one: ${version.slice(0, 40)}`);
    artifact = { url: allowedUrl(id, manifest.url, "artifact"), digest: { algorithm: "sha512", hex: hexDigest(manifest.sha512, "sha512", "sha512") } };
  }
  return { version, artifacts: { [arch]: artifact } };
}

/** Removes the versions no CLI uses and old shim generations; only while no sandbox runs. */
export function removeUnusedCli(paths: PluginPaths): string[] {
  const dirs = cliDirs(paths);
  const installed = readInstalled(paths);
  const removed: string[] = [];
  for (const id of CLI_IDS) {
    for (const version of installedVersions(paths, id)) {
      if (installed[id]?.version === version) continue;
      rmSync(join(dirs.tools, id, version), { recursive: true, force: true });
      removed.push(`${id} ${version}`);
    }
  }
  let sandboxes: string[] = [];
  try {
    sandboxes = readdirSync(dirs.shims);
  } catch {
    sandboxes = [];
  }
  for (const sandbox of sandboxes) {
    const dir = join(dirs.shims, sandbox);
    const generations = readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    // The newest ones belong to the last session of each agent and to the Sandbox terminal.
    for (const old of generations.slice(3)) rmSync(join(dir, old), { recursive: true, force: true });
  }
  return removed;
}

// --- a sandbox's CLIs -------------------------------------------------------------------

const templateFlavors = { at: 0, flavors: new Map<string, string | null>() };

/**
 * The kit a sandbox runs: recorded at creation since the plugin records it, else the template's
 * flavor, else the agent that starts it. A failed template listing falls back to the agent's.
 */
export async function sandboxKit(
  paths: PluginPaths,
  recorded: { kit?: string | null; template?: string | null } | null,
  template: string | null,
  agent: AgentId,
): Promise<string> {
  if (recorded?.kit) return recorded.kit;
  const ref = recorded ? (recorded.template ?? null) : template;
  if (!ref) return recorded ? "claude" : agent;
  if (Date.now() - templateFlavors.at > 60_000) {
    try {
      const list = JSON.parse((await runSbxOk(paths, ["template", "ls", "--json"], "sbx template ls")) || "[]") as {
        repository: string;
        tag: string;
        id: string;
        flavor?: string;
      }[];
      templateFlavors.flavors = new Map();
      for (const entry of list) {
        templateFlavors.flavors.set(`${entry.repository}:${entry.tag}`, entry.flavor ?? null);
        templateFlavors.flavors.set(entry.id, entry.flavor ?? null);
      }
      templateFlavors.at = Date.now();
    } catch {
      return agent;
    }
  }
  const flavor = templateFlavors.flavors.get(normalizeTemplateRef(ref)) ?? templateFlavors.flavors.get(ref);
  return kitForFlavor(flavor) ?? agent;
}

export function resetCliToolsForTests(): void {
  installs.clear();
  lastErrors.clear();
  templateFlavors.at = 0;
  templateFlavors.flavors = new Map();
}

export interface CliPlanInput {
  paths: PluginPaths;
  settings: SandboxSettings;
  repoKey: string;
  sandbox: string;
  claudeConfigDir: string;
  kit: string | null;
  /** The session's agent; null for the Sandbox terminal. */
  agent: AgentId | null;
}

interface StatePlan {
  id: CliId;
  key: string;
  /** On the host, in the sandbox's config dir. */
  dir: string;
  /** In the guest's home. */
  home: string;
}

interface CredentialPlan {
  id: CliId;
  /** The CLI's file in its state; a link to `shared` in the global scope. */
  local: string;
  /** Where the credential lives: the global folder, or the state itself. */
  source: string;
  shared: string | null;
  /** In the guest's home, where the CLI reads it. */
  guestPath: string | null;
}

export interface CliPlan {
  scope: CliScope;
  /** The sbx kit of the sandbox: its own agent is never additional. */
  kit: string | null;
  /** Turned on for the repository and possible in this sandbox's kit: their state is bound in the VM. */
  ids: CliId[];
  /** Of those, the ones this session gets a shim for (installed and not its own agent). */
  session: CliId[];
  /** Turned on and possible, but not installed yet. */
  missing: CliId[];
  /** The credentials folder the sandbox mounts in the global scope; null otherwise. */
  mount: string | null;
  states: StatePlan[];
  credentials: CredentialPlan[];
  /** Claude's token file, for the scope. */
  tokens: Partial<Record<CliId, string>>;
  /** The session's shims and manifest, then the Sandbox terminal's; each in a folder named by its content. */
  generations: CliGeneration[];
  spec: SandboxCli | null;
}

export interface CliGeneration {
  ids: CliId[];
  dir: string;
  shims: Record<string, string>;
  manifest: Record<string, unknown>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Where a CLI's credential lives for a sandbox and scope; the token file for a token CLI. */
export function cliCredentialPath(paths: PluginPaths, claudeConfigDir: string, id: CliId, scope: CliScope): string {
  const tool = CLI_TOOLS[id];
  const credential = tool.credential;
  if (credential.kind === "token") {
    return scope === "global" ? join(cliDirs(paths).authGlobal, id, credential.file) : join(cliStateRoot(claudeConfigDir), id, credential.file);
  }
  return scope === "global"
    ? join(cliDirs(paths).authGlobal, id, basename(credential.path))
    : join(cliStateRoot(claudeConfigDir), id, credential.state, credential.path);
}

/** Whether a CLI has a credential for a sandbox in a scope: present, not checked. */
export function cliCredentialPresent(paths: PluginPaths, claudeConfigDir: string, id: CliId, scope: CliScope): boolean {
  try {
    const stat = statSync(cliCredentialPath(paths, claudeConfigDir, id, scope));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function shimSource(id: CliId, version: string, entry: string, sandbox: string, homes: string[], token: string | null): string {
  const tool = CLI_TOOLS[id];
  const lines = [
    "#!/bin/sh",
    `# Written by the paseo-sbx Paseo plugin: ${tool.label} ${version}, an additional CLI of ${sandbox}.`,
    // Its state is bound at every launch, and binds do not survive a VM restart: without them the
    // CLI would write its state, and its sign-in, into the VM's home.
    `for state in ${homes.map((home) => `"$HOME/${home}"`).join(" ")}; do`,
    `  if ! mountpoint -q "$state" 2>/dev/null; then`,
    `    echo "${CLI_SHIM_PREFIX}${id}: $state is not mounted; start an agent or open the Sandbox terminal in this workspace" >&2`,
    `    exit ${CLI_SHIM_UNMOUNTED_EXIT}`,
    "  fi",
    "done",
  ];
  if (tool.unsetEnv.length > 0) lines.push(`unset ${tool.unsetEnv.join(" ")}`);
  for (const [name, value] of Object.entries(tool.env)) lines.push(`export ${name}="${value}"`);
  if (token && tool.credential.kind === "token") {
    lines.push(
      `token=$(cat ${shellQuote(token)} 2>/dev/null)`,
      `if [ -n "$token" ]; then export ${tool.credential.env}="$token"; fi`,
      "unset token",
    );
  }
  lines.push(`exec ${shellQuote(entry)} "$@"`, "");
  return lines.join("\n");
}

/**
 * What a sandbox's additional CLIs need, computed without writing anything: their state folders,
 * credentials, the shims of this session and the manifest. `writeCliPlan` puts it on disk.
 */
export function planCli(input: CliPlanInput): CliPlan {
  const { paths, settings, repoKey, sandbox, claudeConfigDir, kit, agent } = input;
  const dirs = cliDirs(paths);
  const scope = cliScope(settings, repoKey);
  const installed = readInstalled(paths);
  const ids = cliSelected(settings, repoKey).filter((id) => cliAvailable(id, kit, null));
  const states: StatePlan[] = [];
  const credentials: CredentialPlan[] = [];
  const tokens: Partial<Record<CliId, string>> = {};
  for (const id of ids) {
    const tool = CLI_TOOLS[id];
    for (const state of tool.state) {
      states.push({ id, key: state.key, dir: join(cliStateRoot(claudeConfigDir), id, state.key), home: state.home });
    }
    const credential = tool.credential;
    if (credential.kind === "file") {
      const local = join(cliStateRoot(claudeConfigDir), id, credential.state, credential.path);
      const shared = scope === "global" ? cliCredentialPath(paths, claudeConfigDir, id, "global") : null;
      const home = tool.state.find((state) => state.key === credential.state)?.home ?? "";
      credentials.push({ id, local, shared, source: shared ?? local, guestPath: `${GUEST_HOME}/${home}/${credential.path}` });
    } else {
      tokens[id] = cliCredentialPath(paths, claudeConfigDir, id, scope);
    }
  }
  const generate = (role: AgentId | null) => {
    const included = ids.filter((id) => installed[id] && cliAvailable(id, kit, role));
    const shims: Record<string, string> = {};
    const clis: Record<string, Record<string, unknown>> = {};
    for (const id of included) {
      const version = installed[id]!.version;
      const entry = cliEntry(paths, id, version);
      const homes = CLI_TOOLS[id].state.map((state) => state.home);
      shims[id] = shimSource(id, version, entry, sandbox, homes, tokens[id] ?? null);
      clis[id] = {
        version,
        binary: entry,
        state: homes.map((home) => `${GUEST_HOME}/${home}`),
        // A credential that does not exist yet (not signed in) is left out: there is nothing to bind.
        credentials: credentials
          .filter((credential) => credential.id === id && credential.guestPath && isRegularFile(credential.source))
          .map((credential) => ({ path: credential.guestPath, source: credential.source })),
        login: CLI_TOOLS[id].login,
      };
    }
    const base = {
      version: CLI_MANIFEST_VERSION,
      sandbox,
      scope,
      clis,
      credential_roots: [dirs.auth, paths.homesDir, claudeConfigDir],
      fix_hint: "Docker Sandboxes, the workspace's CLIs tab; sign in from the workspace's Sandbox terminal",
    };
    const name = createHash("sha256").update(JSON.stringify({ shims, base })).digest("hex").slice(0, 16);
    const dir = join(dirs.shims, sandbox, name);
    for (const id of Object.keys(clis)) clis[id].shim = join(dir, id);
    return { ids: included, dir, shims, manifest: { ...base, read_roots: [dirs.tools, dir] } };
  };
  const session = generate(agent);
  const terminal = generate(null);
  const missing = ids.filter((id) => !installed[id]);
  const mount = scope === "global" && ids.length > 0 ? dirs.authGlobal : null;
  const spec: SandboxCli | null =
    ids.length > 0
      ? {
          path: session.dir,
          manifest: join(session.dir, "manifest.json"),
          terminal: { path: terminal.dir, manifest: join(terminal.dir, "manifest.json") },
          mounts: states.map((state): HomeMount => ({ name: state.home, target: state.dir })),
        }
      : null;
  return { scope, kit, ids, session: session.ids, missing, mount, states, credentials, tokens, generations: [session, terminal], spec };
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Puts a plan on disk: each state folder with its marker, each credential where its scope keeps
 * it, and the session's shims and manifest in a folder no later plan rewrites. Returns what it
 * had to repair, for the log.
 */
export function writeCliPlan(plan: CliPlan, sandbox: string): string[] {
  const notes: string[] = [];
  if (plan.ids.length === 0) return notes;
  for (const state of plan.states) {
    mkdirSync(state.dir, { recursive: true, mode: 0o700 });
    const marker = join(state.dir, STATE_MARKER);
    const content = `paseo-sbx ${state.id} ${state.key} ${sandbox}\n`;
    if (!existsSync(marker) || readFileSync(marker, "utf8") !== content) writeFileSync(marker, content);
  }
  for (const credential of plan.credentials) {
    mkdirSync(dirname(credential.local), { recursive: true, mode: 0o700 });
    let local: ReturnType<typeof lstatSync> | null = null;
    try {
      local = lstatSync(credential.local);
    } catch {
      local = null;
    }
    if (credential.shared === null) {
      // Kept in the sandbox now: a link left from the global scope goes, and the CLI signs in here.
      if (local?.isSymbolicLink()) {
        unlinkSync(credential.local);
        notes.push(`${credential.id}: the sandbox no longer shares its credential; sign in again here`);
      }
      continue;
    }
    mkdirSync(dirname(credential.shared), { recursive: true, mode: 0o700 });
    if (local?.isSymbolicLink() && readlinkSync(credential.local) === credential.shared) continue;
    if (local?.isFile()) {
      // The CLI replaced the link with a file (a renewal by rename, a login): the newer copy is
      // the credential, so it moves to the shared folder.
      let sharedTime = -1;
      try {
        sharedTime = statSync(credential.shared).mtimeMs;
      } catch {
        sharedTime = -1;
      }
      if (local.mtimeMs > sharedTime) {
        renameSync(credential.local, credential.shared);
        notes.push(`${credential.id}: adopted the sandbox's newer credential as the shared one`);
      } else {
        unlinkSync(credential.local);
        notes.push(`${credential.id}: replaced an older copy of the credential with the shared one`);
      }
    } else if (local) {
      rmSync(credential.local, { recursive: true, force: true });
    }
    symlinkSync(credential.shared, credential.local);
  }
  for (const token of Object.values(plan.tokens)) mkdirSync(dirname(token!), { recursive: true, mode: 0o700 });
  for (const generation of plan.generations) writeGeneration(generation);
  return notes;
}

/**
 * Writes a plan for a session or the Sandbox terminal without ever failing it: what goes wrong
 * is logged, and the shims refuse to run on their own when their state is not there.
 */
export function saveCliPlan(plan: CliPlan | null, sandbox: string): void {
  if (!plan) return;
  try {
    for (const note of writeCliPlan(plan, sandbox)) console.warn(`[paseo-sbx] ${sandbox}: ${note}`);
  } catch (error) {
    console.warn(`[paseo-sbx] ${sandbox}: preparing the additional CLIs: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeGeneration(generation: CliGeneration): void {
  if (existsSync(join(generation.dir, "manifest.json"))) return;
  const temp = `${generation.dir}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  mkdirSync(temp, { recursive: true });
  for (const [id, source] of Object.entries(generation.shims)) writeFileSync(join(temp, id), source, { mode: 0o755 });
  writeFileSync(join(temp, "manifest.json"), `${JSON.stringify(generation.manifest, null, 2)}\n`, { mode: 0o644 });
  try {
    renameSync(temp, generation.dir);
  } catch (error) {
    // Another launch wrote the same generation first.
    rmSync(temp, { recursive: true, force: true });
    if (!existsSync(join(generation.dir, "manifest.json"))) throw error;
  }
}

// --- signing in and testing ----------------------------------------------------------

const CLAUDE_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

/** Stores Claude's long-lived token (`claude setup-token`) where the scope keeps it. */
export function storeClaudeToken(paths: PluginPaths, claudeConfigDir: string | null, scope: CliScope, token: string): string {
  const value = token.trim();
  if (!CLAUDE_TOKEN.test(value)) throw new Error("this is not a token from claude setup-token (it starts with sk-ant-oat01-)");
  if (scope === "sandbox" && !claudeConfigDir) throw new Error("a sandbox's token needs its workspace");
  const file = cliCredentialPath(paths, claudeConfigDir ?? "", "claude", scope);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, file);
  return file;
}

export type CliTestStatus = "ok" | "login" | "not-mounted" | "quota" | "missing" | "error";

export interface CliTest {
  status: CliTestStatus;
  detail: string;
}

const LOGIN = /\b(401|unauthori[sz]ed|missing (meta )?credentials|not (signed|logged) in|log in|sign in|authentication (required|expired|failed)|login (required|expired)|token (expired|revoked|is invalid)|invalid_grant|refresh_token_reused)\b/i;
const QUOTA = /(usage limit|rate limit|weekly limit|hit your (weekly |daily )?limit|quota|insufficient_quota|too many requests|\b429\b)/i;
const SECRET = /(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})|((sk|rt|ya29|ghp|gho|1\/\/)[-\w.]{16,})/g;

/** The last lines of a probe's output, without anything that looks like a credential. */
function masked(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ")
    .replace(SECRET, "****")
    .slice(0, 300);
}

/** What a probe's exit and output say about the CLI's sign-in. */
export function classifyProbe(id: CliId, code: number, output: string): CliTest {
  const detail = masked(output);
  if (code === CLI_SHIM_UNMOUNTED_EXIT && output.includes(CLI_SHIM_PREFIX)) return { status: "not-mounted", detail };
  if (code === 127) return { status: "missing", detail };
  if (id === "claude") {
    if (/"loggedIn"\s*:\s*true/.test(output)) return { status: "ok", detail: "signed in" };
    return { status: QUOTA.test(output) ? "quota" : "login", detail };
  }
  if (code === 0 && !LOGIN.test(output)) return { status: "ok", detail: id === "codex" ? detail : "signed in" };
  if (LOGIN.test(output)) return { status: "login", detail };
  if (QUOTA.test(output)) return { status: "quota", detail };
  return { status: "error", detail: detail || `exit ${code}` };
}

/** Runs a CLI's sign-in probe in the running sandbox, through the session's shim. */
export async function testCli(paths: PluginPaths, sandbox: string, id: CliId, shimDir: string): Promise<CliTest> {
  const result = await runSbx(
    paths,
    ["exec", sandbox, "env", `PATH=${shimDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, ...CLI_TOOLS[id].probe],
    60_000,
  );
  return classifyProbe(id, result.code, `${result.stdout}\n${result.stderr}`);
}
