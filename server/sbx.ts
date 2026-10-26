import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SPEC_ENV, type HomeMount, type SandboxSpec } from "../shared/spec";
import type { SandboxSummary } from "../shared/rpc";
import { newLockToken, withSandboxLock } from "./lock";
import type { PluginPaths } from "./paths";
import { readSandboxState, removeSandboxState, writeSandboxState } from "./state";

export interface SbxResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the sbx CLI against the Paseo-only instance. Never throws for a non-zero exit. */
export function runSbx(paths: PluginPaths, args: string[], timeoutMs = 60_000): Promise<SbxResult> {
  return new Promise((resolve) => {
    execFile(
      "sbx",
      args,
      {
        env: { ...process.env, XDG_STATE_HOME: paths.stateHome },
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : error.code ? 127 : 1;
        resolve({ code, stdout: stdout ?? "", stderr: stderr || (error?.message ?? "") });
      },
    );
  });
}

const SIGN_IN_PATTERN = /keychain[^\n]*locked|keyring[^\n]*locked|not signed in/i;

export class SbxError extends Error {
  constructor(
    readonly operation: string,
    readonly result: SbxResult,
  ) {
    const output = (result.stderr || result.stdout).trim();
    const hint = SIGN_IN_PATTERN.test(output)
      ? " (sbx cannot read its login: unlock the OS keyring, or use one without a password, and run sbx login)"
      : "";
    super(`${operation} failed (exit ${result.code})${hint}: ${output}`);
    this.name = "SbxError";
  }
}

export async function runSbxOk(paths: PluginPaths, args: string[], operation: string, timeoutMs?: number): Promise<string> {
  const result = await runSbx(paths, args, timeoutMs);
  if (result.code !== 0) throw new SbxError(operation, result);
  return result.stdout;
}

export interface SbxHealth {
  installed: boolean;
  version: string | null;
  daemon: "running" | "stopped" | "unavailable";
  error: string | null;
}

export async function sbxHealth(paths: PluginPaths): Promise<SbxHealth> {
  const version = await runSbx(paths, ["version"], 15_000);
  if (version.code === 127) {
    return { installed: false, version: null, daemon: "unavailable", error: "sbx is not installed" };
  }
  const versionMatch = /(?:Client Version:|sbx version)\s*(v?[0-9][^\s]*)/.exec(version.stdout);
  const status = await runSbx(paths, ["daemon", "status"], 15_000);
  const daemon = /Status:\s*\S*\s*running/.test(status.stdout)
    ? "running"
    : /Status:\s*\S*\s*stopped/.test(status.stdout)
      ? "stopped"
      : "unavailable";
  return {
    installed: true,
    version: versionMatch?.[1] ?? null,
    daemon,
    error: daemon === "unavailable" ? (status.stderr || status.stdout).trim() || null : null,
  };
}

interface SbxListEntry {
  name: string;
  status?: string;
  workspaces?: string[];
  memory?: string;
}

/** Lists the Paseo-only instance's sandboxes. Starts its daemon when it is not running. */
export async function listSandboxes(paths: PluginPaths): Promise<SandboxSummary[]> {
  const stdout = await runSbxOk(paths, ["ls", "--json"], "sbx ls");
  const entries = JSON.parse(stdout || "[]") as SbxListEntry[];
  return entries.map((entry) => {
    const state = readSandboxState(paths, entry.name);
    return {
      name: entry.name,
      status: entry.status ?? "unknown",
      workspaces: entry.workspaces ?? [],
      memory: entry.memory ?? null,
      kind: state?.kind === "template-prep" ? ("template-prep" as const) : ("working" as const),
      repoKey: state?.repoKey ?? null,
      template: state?.template ?? null,
    };
  });
}

/** RPC input names must be ones this plugin generates; they also become file names. */
export function assertSandboxName(name: string): void {
  if (!/^paseo-[a-z0-9-]+-[0-9a-f]{8}$/.test(name)) throw new Error(`not a paseo-sbx sandbox: ${name}`);
}

/**
 * Stops the VM after asking its Docker daemon to shut down: dockerd stops the containers without
 * marking them stopped by the user, so `unless-stopped` containers come back on the next start
 * and databases skip crash recovery. `sbx stop` alone, the auto-stop and the death of the Paseo
 * service all stop the VM like a power cut.
 */
export async function stopSandbox(paths: PluginPaths, name: string): Promise<{ graceful: boolean }> {
  assertSandboxName(name);
  return withSandboxLock(paths, name, newLockToken(), () => stopSandboxLocked(paths, name));
}

/** `stopSandbox` for callers that already hold the sandbox lock. */
export async function stopSandboxLocked(paths: PluginPaths, name: string): Promise<{ graceful: boolean }> {
  const entries = JSON.parse((await runSbxOk(paths, ["ls", "--json"], "sbx ls")) || "[]") as SbxListEntry[];
  if (entries.find((entry) => entry.name === name)?.status !== "running") return { graceful: true };
  const shutdown = await runSbx(paths, ["exec", "-u", "root", name, "sh", "-c", DOCKERD_SHUTDOWN], 30_000);
  await runSbxOk(paths, ["stop", name], `sbx stop ${name}`);
  return { graceful: shutdown.code === 0 };
}

// SIGTERM to the guest's dockerd, then up to 20 s for it to stop its containers and exit.
const DOCKERD_SHUTDOWN = [
  'pid=$(cat /var/run/docker.pid 2>/dev/null || pidof dockerd)',
  '[ -n "$pid" ] || exit 0',
  'kill -TERM $pid || exit 0',
  'i=0',
  'while kill -0 $pid 2>/dev/null; do i=$((i+1)); [ $i -gt 200 ] && exit 3; sleep 0.1; done',
].join("\n");

/** Removes the sandbox with its state and leases; the Claude config dir and transcripts stay. */
export async function removeSandbox(paths: PluginPaths, name: string): Promise<void> {
  assertSandboxName(name);
  await withSandboxLock(paths, name, newLockToken(), () => removeSandboxLocked(paths, name));
}

/**
 * `removeSandbox` for callers that already hold the sandbox lock. A recreation keeps the
 * publications chosen for the sandbox: the wrapper reapplies them to the new one.
 */
export async function removeSandboxLocked(
  paths: PluginPaths,
  name: string,
  options: { keepPublications?: boolean } = {},
): Promise<void> {
  const publications = options.keepPublications ? readSandboxState(paths, name)?.publications : undefined;
  await runSbxOk(paths, ["rm", "-f", name], `sbx rm ${name}`);
  removeSandboxState(paths, name);
  if (publications) writeSandboxState(paths, name, { publications });
  rmSync(join(paths.locksDir, `${name}.leases`), { recursive: true, force: true });
}

/**
 * Creates the sandbox and applies its policy through the wrapper's ensure mode. A caller holding
 * the sandbox lock passes its token so the wrapper runs inside that lock.
 */
export function prepareSandbox(paths: PluginPaths, spec: SandboxSpec, lockToken?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, [SPEC_ENV]: JSON.stringify(spec) };
    if (lockToken) env.PASEO_SBX_LOCK_TOKEN = lockToken;
    const child = spawn(paths.launcher, ["--paseo-sbx-ensure"], {
      cwd: spec.workspace,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`preparing ${spec.name} failed: ${stderr.trim().slice(-800)}`));
    });
  });
}

/**
 * A login shell in the sandbox; `noHistory` keeps it from writing a shell history to save in a
 * template. `homeMounts` are applied first, as a session's launch does.
 */
export function shellCommand(
  paths: PluginPaths,
  name: string,
  options: { noHistory?: boolean; homeMounts?: readonly HomeMount[] } = {},
): { command: string; args: string[] } {
  const historyArgs = options.noHistory ? ["-e", "HISTFILE=/dev/null"] : [];
  const mounts = (options.homeMounts ?? []).flatMap((mount) => [mount.name, mount.target]);
  const shell =
    mounts.length > 0
      ? ["sh", "-c", 'sh "$0" "$@"; exec bash -l', join(paths.binDir, "home-mounts.sh"), ...mounts]
      : ["bash", "-l"];
  return {
    command: "env",
    args: [`XDG_STATE_HOME=${paths.stateHome}`, "sbx", "exec", "-it", ...historyArgs, name, ...shell],
  };
}
