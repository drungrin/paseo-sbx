import { mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SandboxSettings } from "../shared/settings";
import { vmShims } from "./memory";
import type { PluginPaths } from "./paths";

/**
 * Where sbx 0.49 keeps a sandbox's disks on this host, an internal detail of it: the VM's Docker
 * disk and its agents' state volumes are block images named after the sandbox, and the changes to
 * its filesystem are a containerd snapshot's `rwlayer.img`. Anything unexpected reads as unknown.
 */
function containerdRoot(paths: PluginPaths): string {
  return join(paths.stateHome, "sandboxes", "sandboxes", "sandboxd", "containerd", "root");
}

export function blockImagesDir(paths: PluginPaths): string {
  return join(containerdRoot(paths), "com.docker.volume.driver.v1.block", "images");
}

export function snapshotsDir(paths: PluginPaths): string {
  return join(containerdRoot(paths), "io.containerd.snapshotter.v1.erofs", "snapshots");
}

function contentDir(paths: PluginPaths): string {
  return join(containerdRoot(paths), "io.containerd.content.v1.content", "blobs");
}

/** Which snapshot holds each sandbox's filesystem changes, as last seen while it ran. */
function layersCachePath(paths: PluginPaths): string {
  return join(paths.root, "rootfs-layers.json");
}

export interface FileUse {
  /** Space the file takes on the host: the images are sparse. */
  usedBytes: number;
  /** Its size, which is the disk's size as the VM sees it. */
  sizeBytes: number;
}

function fileUse(path: string): FileUse | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { usedBytes: stat.blocks * 512, sizeBytes: stat.size } : null;
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isRootfsLayer(paths: PluginPaths, path: string): boolean {
  return basename(path) === "rwlayer.img" && dirname(dirname(path)) === snapshotsDir(paths);
}

/** The `rwlayer.img` each running VM keeps open: its filesystem's changes. */
export function vmRootfsLayers(paths: PluginPaths, procRoot = "/proc"): Map<string, string> {
  const result = new Map<string, string>();
  for (const { pid, hostname } of vmShims(paths, procRoot)) {
    const fdDir = join(procRoot, pid, "fd");
    for (const fd of listDir(fdDir)) {
      let target: string;
      try {
        target = readlinkSync(join(fdDir, fd));
      } catch {
        continue;
      }
      if (isRootfsLayer(paths, target)) result.set(hostname, target);
    }
  }
  return result;
}

/**
 * The filesystem layer of each sandbox: a running one's from its VM, a stopped one's as it was
 * last seen running. A layer that no longer exists, after a removal or a recreation, is forgotten.
 */
export function rootfsLayers(paths: PluginPaths, procRoot = "/proc"): Map<string, string> {
  const cachePath = layersCachePath(paths);
  let cached: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cached = parsed as Record<string, unknown>;
  } catch {
    cached = {};
  }
  const layers = new Map<string, string>();
  for (const [name, path] of Object.entries(cached)) {
    if (typeof path === "string" && isRootfsLayer(paths, path)) layers.set(name, path);
  }
  for (const [name, path] of vmRootfsLayers(paths, procRoot)) layers.set(name, path);
  for (const [name, path] of layers) if (fileUse(path) === null) layers.delete(name);
  const next = Object.fromEntries([...layers].sort(([a], [b]) => a.localeCompare(b)));
  if (JSON.stringify(next) !== JSON.stringify(cached)) {
    try {
      mkdirSync(paths.root, { recursive: true });
      writeFileSync(cachePath, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      // Only stopped sandboxes' figures depend on it.
    }
  }
  return layers;
}

export interface SandboxDisk {
  name: string;
  /** Everything below, on the host. */
  usedBytes: number;
  /** The VM's `/var/lib/docker`; null when unknown. */
  docker: FileUse | null;
  /** Changes to the VM's filesystem; null when unknown, such as a sandbox not seen running. */
  rootfs: FileUse | null;
  /** The agents' state volumes, such as Claude's projects and sessions. */
  agentBytes: number;
}

/** A sandbox's agent volume: `sandbox-plugin-<sandbox>-<agent>-<hash>.img`. */
function agentVolumeOf(file: string, name: string): boolean {
  const prefix = `sandbox-plugin-${name}-`;
  return file.startsWith(prefix) && /^[a-z0-9]+-[0-9a-f]{12}\.img$/.test(file.slice(prefix.length));
}

/** What each sandbox's files take on the host; a sandbox with none found is left out. */
export function sandboxDisks(paths: PluginPaths, names: readonly string[], procRoot = "/proc"): SandboxDisk[] {
  const imagesDir = blockImagesDir(paths);
  const images = listDir(imagesDir);
  const layers = rootfsLayers(paths, procRoot);
  const result: SandboxDisk[] = [];
  for (const name of names) {
    const docker = images.includes(`${name}-docker.img`) ? fileUse(join(imagesDir, `${name}-docker.img`)) : null;
    const layer = layers.get(name);
    const rootfs = layer ? fileUse(layer) : null;
    const agentBytes = images
      .filter((file) => agentVolumeOf(file, name))
      .reduce((sum, file) => sum + (fileUse(join(imagesDir, file))?.usedBytes ?? 0), 0);
    if (docker === null && rootfs === null && agentBytes === 0) continue;
    result.push({ name, usedBytes: (docker?.usedBytes ?? 0) + (rootfs?.usedBytes ?? 0) + agentBytes, docker, rootfs, agentBytes });
  }
  return result;
}

/** Image layers and templates, shared between sandboxes: the snapshots' layers and the content store. */
export function sharedImageBytes(paths: PluginPaths): number {
  const snapshots = snapshotsDir(paths);
  let total = 0;
  for (const id of listDir(snapshots)) total += fileUse(join(snapshots, id, "layer.erofs"))?.usedBytes ?? 0;
  const blobs = contentDir(paths);
  for (const algorithm of listDir(blobs)) {
    for (const blob of listDir(join(blobs, algorithm))) total += fileUse(join(blobs, algorithm, blob))?.usedBytes ?? 0;
  }
  return total;
}

export interface HostDisk {
  /** Where the sandboxes' files live. */
  path: string;
  totalBytes: number;
  /** Free to you: excludes the blocks the filesystem reserves for root. */
  availableBytes: number;
}

export function hostDisk(paths: PluginPaths): HostDisk | null {
  try {
    const stat = statfsSync(paths.stateHome);
    return { path: paths.stateHome, totalBytes: stat.blocks * stat.bsize, availableBytes: stat.bavail * stat.bsize };
  } catch {
    return null;
  }
}

export function diskAlerts(host: HostDisk, alert: SandboxSettings["diskAlert"]): string[] {
  if (host.totalBytes <= 0) return [];
  const availablePercent = (host.availableBytes / host.totalBytes) * 100;
  return availablePercent < alert.availablePercent ? [`only ${availablePercent.toFixed(0)}% of the disk free`] : [];
}
