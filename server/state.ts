import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginPaths } from "./paths";

/**
 * What the plugin knows about a sandbox, shared with the wrapper (which writes it when it creates
 * the sandbox) in `sandboxes/<name>.json`.
 */
export interface SandboxState {
  key?: string;
  repoKey?: string;
  workspace?: string;
  claudeConfigDir?: string;
  template?: string | null;
  templateImageId?: string | null;
  memory?: string;
  /** Network rules applied to the sandbox, reconciled per launch. */
  policies?: string[];
  /** A template preparation sandbox, not a working one. */
  kind?: "template-prep";
}

function statePath(paths: PluginPaths, name: string): string {
  return join(paths.stateDir, `${name}.json`);
}

export function readSandboxState(paths: PluginPaths, name: string): SandboxState | null {
  try {
    return JSON.parse(readFileSync(statePath(paths, name), "utf8")) as SandboxState;
  } catch {
    return null;
  }
}

export function writeSandboxState(paths: PluginPaths, name: string, state: SandboxState): void {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(statePath(paths, name), `${JSON.stringify(state, null, 2)}\n`);
}

export function removeSandboxState(paths: PluginPaths, name: string): void {
  rmSync(statePath(paths, name), { force: true });
}

/** Linux start time of a process (field 22 of /proc/<pid>/stat), or "" where unavailable. */
export function processStart(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(")").pop()?.trim().split(/\s+/)[19] ?? "";
  } catch {
    return "";
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A process identified by pid and start time, so a reused pid does not pass for it. */
export interface ProcessRef {
  pid: number;
  start: string;
}

export function sameProcessAlive(ref: ProcessRef): boolean {
  if (!processAlive(ref.pid)) return false;
  const start = processStart(ref.pid);
  return ref.start === "" || start === "" || start === ref.start;
}

export function currentProcess(): ProcessRef {
  return { pid: process.pid, start: processStart(process.pid) };
}

/** A running wrapper session, written by the wrapper in `locks/<name>.leases/<pid>`. */
export interface Lease extends ProcessRef {
  agentId: string | null;
}

/** Sessions the wrapper is running in the sandbox; leases of dead processes are removed. */
export function liveLeases(paths: PluginPaths, name: string): Lease[] {
  const dir = join(paths.locksDir, `${name}.leases`);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const live: Lease[] = [];
  for (const entry of entries) {
    const file = join(dir, entry);
    try {
      const lease = JSON.parse(readFileSync(file, "utf8")) as Lease;
      if (typeof lease.pid === "number" && sameProcessAlive(lease)) live.push(lease);
      else rmSync(file, { force: true });
    } catch {
      rmSync(file, { force: true });
    }
  }
  return live;
}

/** Marks a recreation in progress; wrappers refuse to launch while its owner is alive. */
export interface RecreatingMarker extends ProcessRef {
  token: string;
  phase: "waiting" | "removing" | "creating";
}

function markerPath(paths: PluginPaths, name: string): string {
  return join(paths.locksDir, `${name}.recreating`);
}

export function writeRecreatingMarker(paths: PluginPaths, name: string, marker: RecreatingMarker): void {
  mkdirSync(paths.locksDir, { recursive: true });
  writeFileSync(markerPath(paths, name), JSON.stringify(marker));
}

export function removeRecreatingMarker(paths: PluginPaths, name: string): void {
  rmSync(markerPath(paths, name), { force: true });
}

/** Removes markers whose owner died mid-recreation (the plugin restarted). */
export function reconcileRecreatingMarkers(paths: PluginPaths): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(paths.locksDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".recreating")) continue;
    const file = join(paths.locksDir, entry);
    try {
      const marker = JSON.parse(readFileSync(file, "utf8")) as RecreatingMarker;
      if (sameProcessAlive(marker)) continue;
    } catch {
      // unreadable: treat as interrupted
    }
    rmSync(file, { force: true });
    removed.push(entry.slice(0, -".recreating".length));
  }
  return removed;
}
