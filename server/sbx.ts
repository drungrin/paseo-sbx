import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SPEC_ENV, type SandboxSpec } from "../shared/spec";
import type { SandboxSummary } from "../shared/rpc";
import type { PluginPaths } from "./paths";

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

export class SbxError extends Error {
  constructor(
    readonly operation: string,
    readonly result: SbxResult,
  ) {
    super(`${operation} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
    this.name = "SbxError";
  }
}

async function runSbxOk(paths: PluginPaths, args: string[], operation: string): Promise<string> {
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
  return entries.map((entry) => ({
    name: entry.name,
    status: entry.status ?? "unknown",
    workspaces: entry.workspaces ?? [],
    memory: entry.memory ?? null,
  }));
}

export async function stopSandbox(paths: PluginPaths, name: string): Promise<void> {
  await runSbxOk(paths, ["stop", name], `sbx stop ${name}`);
}

/** Removes the sandbox and the wrapper's record of the policies applied to it. */
export async function removeSandbox(paths: PluginPaths, name: string): Promise<void> {
  await runSbxOk(paths, ["rm", "-f", name], `sbx rm ${name}`);
  rmSync(join(paths.stateDir, `${name}.json`), { force: true });
}

/** Creates the sandbox and applies its policy through the wrapper's ensure mode. */
export function prepareSandbox(paths: PluginPaths, spec: SandboxSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [paths.wrapper, "--paseo-sbx-ensure"], {
      cwd: spec.workspace,
      env: { ...process.env, [SPEC_ENV]: JSON.stringify(spec) },
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

export function shellCommand(paths: PluginPaths, name: string): { command: string; args: string[] } {
  return {
    command: "env",
    args: [`XDG_STATE_HOME=${paths.stateHome}`, "sbx", "exec", "-it", name, "bash", "-l"],
  };
}
