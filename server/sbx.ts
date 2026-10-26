import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SPEC_ENV, type SandboxSpec } from "../shared/spec";
import type { SandboxSummary } from "../shared/rpc";
import { newLockToken, withSandboxLock } from "./lock";
import type { PluginPaths } from "./paths";
import { readSandboxState, removeSandboxState } from "./state";

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

export async function runSbxOk(paths: PluginPaths, args: string[], operation: string): Promise<string> {
  const result = await runSbx(paths, args);
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

export async function stopSandbox(paths: PluginPaths, name: string): Promise<void> {
  assertSandboxName(name);
  await withSandboxLock(paths, name, newLockToken(), () => runSbxOk(paths, ["stop", name], `sbx stop ${name}`));
}

/** Removes the sandbox with its state and leases; the Claude config dir and transcripts stay. */
export async function removeSandbox(paths: PluginPaths, name: string): Promise<void> {
  assertSandboxName(name);
  await withSandboxLock(paths, name, newLockToken(), () => removeSandboxLocked(paths, name));
}

/** `removeSandbox` for callers that already hold the sandbox lock. */
export async function removeSandboxLocked(paths: PluginPaths, name: string): Promise<void> {
  await runSbxOk(paths, ["rm", "-f", name], `sbx rm ${name}`);
  removeSandboxState(paths, name);
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

/** A login shell in the sandbox; `noHistory` keeps it from writing a shell history to save in a template. */
export function shellCommand(
  paths: PluginPaths,
  name: string,
  options: { noHistory?: boolean } = {},
): { command: string; args: string[] } {
  const historyArgs = options.noHistory ? ["-e", "HISTFILE=/dev/null"] : [];
  return {
    command: "env",
    args: [`XDG_STATE_HOME=${paths.stateHome}`, "sbx", "exec", "-it", ...historyArgs, name, "bash", "-l"],
  };
}
