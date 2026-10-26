import type { LegacyOverride, RepoConfig } from "../shared/settings";
import { repoIdentity } from "./repo";

interface V1Override {
  memoryGiB?: number;
  mounts?: string[];
  envNames?: string[];
}

function sameOverride(a: V1Override, b: V1Override): boolean {
  return JSON.stringify([a.memoryGiB, a.mounts ?? [], a.envNames ?? []]) ===
    JSON.stringify([b.memoryGiB, b.mounts ?? [], b.envNames ?? []]);
}

/**
 * Version 1 kept per-sandbox `overrides` keyed `directory:<path>` or `workspace:<id>`; version 2
 * keys settings by repository. A directory override moves to its repo unless another override
 * of the same repo disagrees. Workspace overrides cannot be resolved here. Everything that does
 * not move lands in `legacyOverrides`, which the Sandboxes screen lists for you to reassign.
 */
export async function migrateSettings(values: unknown, fromVersion: number): Promise<unknown> {
  if (fromVersion !== 1 || values === null || typeof values !== "object") return values;
  const { overrides, ...rest } = values as { overrides?: Record<string, V1Override> };
  const repos: Record<string, Partial<RepoConfig>> = {};
  const movedFrom: Record<string, { origin: string; override: V1Override }> = {};
  const legacyOverrides: Record<string, LegacyOverride> = {};
  const conflicted = new Set<string>();
  const legacy = (key: string, override: V1Override, reason: LegacyOverride["reason"]) => {
    legacyOverrides[key] = {
      memoryGiB: override.memoryGiB,
      mounts: override.mounts ?? [],
      envNames: override.envNames ?? [],
      reason,
    };
  };

  for (const [key, override] of Object.entries(overrides ?? {})) {
    if (!key.startsWith("directory:")) {
      legacy(key, override, key.startsWith("workspace:") ? "workspace" : "unresolved");
      continue;
    }
    const repoKey = (await repoIdentity(key.slice("directory:".length))).key;
    if (conflicted.has(repoKey)) {
      legacy(key, override, "conflict");
      continue;
    }
    const previous = movedFrom[repoKey];
    if (!previous) {
      movedFrom[repoKey] = { origin: key, override };
      repos[repoKey] = { memoryGiB: override.memoryGiB, mounts: override.mounts ?? [], envNames: override.envNames ?? [] };
    } else if (!sameOverride(previous.override, override)) {
      // Two worktrees of one repo disagree: keep both for you to resolve.
      legacy(previous.origin, previous.override, "conflict");
      legacy(key, override, "conflict");
      delete repos[repoKey];
      conflicted.add(repoKey);
    }
  }
  return { ...rest, repos, legacyOverrides };
}
