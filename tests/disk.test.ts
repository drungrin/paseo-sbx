import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockImagesDir, diskAlerts, rootfsLayers, sandboxDisks, snapshotsDir } from "../server/disk";
import { pluginPaths, type PluginPaths } from "../server/paths";
import { sandboxSettingsSchema } from "../shared/settings";

let root: string;
let paths: PluginPaths;
let proc: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-sbx-disk-")));
  paths = pluginPaths({ XDG_STATE_HOME: join(root, "state") }, join(root, "home"));
  proc = join(root, "proc");
  mkdirSync(proc);
  mkdirSync(blockImagesDir(paths), { recursive: true });
  mkdirSync(snapshotsDir(paths), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A sparse file of `size` bytes with `written` bytes of data: the way sbx's disk images look. */
function image(path: string, size: number, written: number): string {
  writeFileSync(path, Buffer.alloc(written, 1));
  truncateSync(path, size);
  return path;
}

function layer(id: number, written: number): string {
  const dir = join(snapshotsDir(paths), String(id));
  mkdirSync(dir, { recursive: true });
  return image(join(dir, "rwlayer.img"), 20 * 1024 ** 2, written);
}

/** A fake /proc entry for a VM shim of `hostname` holding `files` open. */
function shim(pid: number, hostname: string, files: string[]) {
  const dir = join(proc, String(pid));
  const task = join(paths.stateHome, "sandboxes", "sandboxes", "sandboxd", "containerd", "state", "task", String(pid));
  mkdirSync(join(dir, "fd"), { recursive: true });
  mkdirSync(task, { recursive: true });
  writeFileSync(join(dir, "cmdline"), `/usr/libexec/containerd-shim-nerdbox-v1\0-id\0abc\0`);
  writeFileSync(join(task, "config.json"), JSON.stringify({ hostname }));
  symlinkSync(task, join(dir, "cwd"));
  files.forEach((file, index) => symlinkSync(file, join(dir, "fd", String(index + 3))));
}

const MiB = 1024 ** 2;

describe("sandbox disks", () => {
  it("adds up the Docker disk, the filesystem layer and the agents' volumes of each sandbox", () => {
    const images = blockImagesDir(paths);
    image(join(images, "paseo-app-0badc0de-docker.img"), 100 * MiB, 3 * MiB);
    image(join(images, "sandbox-plugin-paseo-app-0badc0de-claude-691d2fcf7e8e.img"), 2 * MiB, MiB);
    // Another sandbox whose name starts with this one's: its volumes are not this one's.
    image(join(images, "sandbox-plugin-paseo-app-0badc0de-x-12345678-claude-691d2fcf7e8e.img"), 2 * MiB, MiB);
    const rootfs = layer(83, 2 * MiB);
    // An image layer the shim also has open is not the filesystem's changes.
    const shared = join(snapshotsDir(paths), "12", "layer.erofs");
    mkdirSync(join(snapshotsDir(paths), "12"));
    writeFileSync(shared, "x");
    shim(101, "paseo-app-0badc0de", [shared, rootfs, "/dev/null"]);

    const [disk] = sandboxDisks(paths, ["paseo-app-0badc0de"], proc);
    expect(disk.name).toBe("paseo-app-0badc0de");
    // Sparse images: the host spends what was written, not their size.
    expect(disk.docker?.sizeBytes).toBe(100 * MiB);
    expect(disk.docker?.usedBytes).toBeGreaterThanOrEqual(3 * MiB);
    expect(disk.docker?.usedBytes).toBeLessThan(100 * MiB);
    expect(disk.rootfs?.sizeBytes).toBe(20 * MiB);
    expect(disk.agentBytes).toBeGreaterThanOrEqual(MiB);
    expect(disk.agentBytes).toBeLessThan(2 * MiB);
    expect(disk.usedBytes).toBe(disk.docker!.usedBytes + disk.rootfs!.usedBytes + disk.agentBytes);
  });

  it("keeps a stopped sandbox's filesystem as last seen running, and forgets it once it is gone", () => {
    const rootfs = layer(75, MiB);
    shim(101, "paseo-app-0badc0de", [rootfs]);
    expect(rootfsLayers(paths, proc).get("paseo-app-0badc0de")).toBe(rootfs);

    // Stopped: no shim left.
    rmSync(join(proc, "101"), { recursive: true });
    expect(rootfsLayers(paths, join(root, "no-proc")).get("paseo-app-0badc0de")).toBe(rootfs);

    // Recreated: its old snapshot is removed.
    rmSync(rootfs);
    expect(rootfsLayers(paths, proc).size).toBe(0);
    expect(JSON.parse(readFileSync(join(paths.root, "rootfs-layers.json"), "utf8"))).toEqual({});
  });

  it("ignores a cache that points outside the snapshots", () => {
    const elsewhere = image(join(root, "rwlayer.img"), MiB, 10);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(join(paths.root, "rootfs-layers.json"), JSON.stringify({ "paseo-app-0badc0de": elsewhere }));
    expect(rootfsLayers(paths, proc).size).toBe(0);
  });

  it("leaves out a sandbox with nothing on disk, and reads a missing store as empty", () => {
    expect(sandboxDisks(paths, ["paseo-new-0badc0de"], proc)).toEqual([]);
    rmSync(join(root, "state"), { recursive: true });
    expect(sandboxDisks(paths, ["paseo-new-0badc0de"], proc)).toEqual([]);
  });
});

describe("disk alerts", () => {
  it("alerts when the free share falls below the threshold", () => {
    const alert = sandboxSettingsSchema.parse({}).diskAlert;
    expect(diskAlerts({ path: "/", totalBytes: 1000, availableBytes: 80 }, alert)).toEqual(["only 8% of the disk free"]);
    expect(diskAlerts({ path: "/", totalBytes: 1000, availableBytes: 300 }, alert)).toEqual([]);
  });
});
