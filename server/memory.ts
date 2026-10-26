import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { SandboxSettings } from "../shared/settings";
import { isWithin } from "../shared/spec";
import type { PluginPaths } from "./paths";

export interface HostMemory {
  totalMiB: number;
  availableMiB: number;
  swapUsedMiB: number;
  /** Memory PSI `some avg60` in percent; null where the kernel does not expose it. */
  psiSome60: number | null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function parseMeminfo(text: string): Omit<HostMemory, "psiSome60"> {
  const kib = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  return {
    totalMiB: Math.round(kib("MemTotal") / 1024),
    availableMiB: Math.round(kib("MemAvailable") / 1024),
    swapUsedMiB: Math.round((kib("SwapTotal") - kib("SwapFree")) / 1024),
  };
}

export function parsePsiSome60(text: string): number | null {
  const value = /^some .*avg60=([\d.]+)/m.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

export function hostMemory(): HostMemory | null {
  const meminfo = readText("/proc/meminfo");
  if (meminfo === null) return null;
  const pressure = readText("/proc/pressure/memory");
  return { ...parseMeminfo(meminfo), psiSome60: pressure === null ? null : parsePsiSome60(pressure) };
}

export function memoryAlerts(host: HostMemory, alert: SandboxSettings["memoryAlert"]): string[] {
  const reasons: string[] = [];
  if (host.psiSome60 !== null && host.psiSome60 >= alert.psiPercent) {
    reasons.push(`memory pressure at ${host.psiSome60.toFixed(1)}% over the last minute`);
  }
  const availablePercent = host.totalMiB > 0 ? (host.availableMiB / host.totalMiB) * 100 : 100;
  if (availablePercent < alert.availablePercent) {
    reasons.push(`only ${availablePercent.toFixed(0)}% of RAM available`);
  }
  return reasons;
}

/**
 * Resident memory of each running VM in the Paseo instance, in MiB, read without entering the VM.
 * sbx 0.49 runs a VM as a `containerd-shim-nerdbox-v1` process whose working directory is the
 * task's state directory, and that directory's `config.json` names the sandbox in `hostname`.
 * An internal detail of sbx: anything unexpected leaves the sandbox out, shown as unknown.
 */
export function vmMemoryMiB(paths: PluginPaths, procRoot = "/proc"): Map<string, number> {
  const result = new Map<string, number>();
  let pids: string[] = [];
  try {
    pids = readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return result;
  }
  for (const pid of pids) {
    const cmdline = readText(join(procRoot, pid, "cmdline"));
    if (!cmdline?.includes("containerd-shim-nerdbox-v1")) continue;
    let cwd: string;
    try {
      cwd = readlinkSync(join(procRoot, pid, "cwd"));
    } catch {
      continue;
    }
    // The main sbx instance's VMs run the same shim; count only this plugin's instance.
    if (!isWithin(cwd, paths.stateHome)) continue;
    const rssKiB = Number(/^VmRSS:\s+(\d+)/m.exec(readText(join(procRoot, pid, "status")) ?? "")?.[1] ?? Number.NaN);
    let hostname: unknown;
    try {
      hostname = (JSON.parse(readFileSync(join(cwd, "config.json"), "utf8")) as { hostname?: unknown }).hostname;
    } catch {
      continue;
    }
    if (typeof hostname !== "string" || !Number.isFinite(rssKiB)) continue;
    result.set(hostname, Math.max(result.get(hostname) ?? 0, Math.round(rssKiB / 1024)));
  }
  return result;
}
