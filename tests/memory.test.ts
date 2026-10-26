import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxSettingsSchema } from "../shared/settings";
import { memoryAlerts, parseMeminfo, parsePsiSome60, vmMemoryMiB } from "../server/memory";
import { pluginPaths, type PluginPaths } from "../server/paths";

let root: string;
let paths: PluginPaths;
let proc: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-sbx-memory-")));
  paths = pluginPaths({ XDG_STATE_HOME: join(root, "state") }, join(root, "home"));
  proc = join(root, "proc");
  mkdirSync(proc);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fake /proc entry for a VM shim whose task state directory names `hostname`. */
function shim(pid: number, stateDir: string, hostname: string | null, rssKiB: number) {
  const dir = join(proc, String(pid));
  mkdirSync(dir);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(dir, "cmdline"), `/usr/libexec/containerd-shim-nerdbox-v1\0-namespace\0docker\0-id\0abc\0`);
  writeFileSync(join(dir, "status"), `Name:\tcontainerd-shim\nVmRSS:\t  ${rssKiB} kB\n`);
  symlinkSync(stateDir, join(dir, "cwd"));
  if (hostname !== null) writeFileSync(join(stateDir, "config.json"), JSON.stringify({ hostname }));
}

describe("VM memory", () => {
  it("maps each VM shim of the Paseo instance to its sandbox", () => {
    const tasks = join(paths.stateHome, "sandboxes", "sandboxes", "sandboxd", "containerd", "state", "task");
    shim(101, join(tasks, "a"), "paseo-app-0badc0de", 1_300_000);
    // The main sbx instance's VMs run the same shim, elsewhere.
    shim(102, join(root, "main-sbx", "task"), "lens-x", 2_000_000);
    // A shim still starting, without its config.
    shim(103, join(tasks, "b"), null, 4_000);
    const other = join(proc, "104");
    mkdirSync(other);
    writeFileSync(join(other, "cmdline"), "node\0server.js\0");

    expect(vmMemoryMiB(paths, proc)).toEqual(new Map([["paseo-app-0badc0de", 1270]]));
  });

  it("returns nothing where /proc cannot be read", () => {
    expect(vmMemoryMiB(paths, join(root, "missing")).size).toBe(0);
  });
});

describe("host memory", () => {
  const meminfo = "MemTotal:       32000000 kB\nMemFree:  1 kB\nMemAvailable:    4000000 kB\nSwapTotal:      8388604 kB\nSwapFree:       4194302 kB\n";

  it("reads totals, availability, swap and pressure", () => {
    expect(parseMeminfo(meminfo)).toEqual({ totalMiB: 31250, availableMiB: 3906, swapUsedMiB: 4096 });
    expect(parsePsiSome60("some avg10=1.50 avg60=12.25 avg300=3.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")).toBe(12.25);
    expect(parsePsiSome60("")).toBeNull();
  });

  it("alerts on pressure even with RAM available, and on low availability", () => {
    const alert = sandboxSettingsSchema.parse({}).memoryAlert;
    expect(memoryAlerts({ totalMiB: 32000, availableMiB: 20000, swapUsedMiB: 0, psiSome60: 12 }, alert)).toEqual([
      "memory pressure at 12.0% over the last minute",
    ]);
    expect(memoryAlerts({ totalMiB: 32000, availableMiB: 3000, swapUsedMiB: 0, psiSome60: null }, alert)).toEqual([
      "only 9% of RAM available",
    ]);
    expect(memoryAlerts({ totalMiB: 32000, availableMiB: 20000, swapUsedMiB: 0, psiSome60: 2 }, alert)).toEqual([]);
  });
});
