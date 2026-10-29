import { DEFAULT_CLAUDE_SHARED, LEGACY_CLAUDE_SHARED, type LegacyOverride, type RepoConfig } from "../shared/settings";
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

/** Paseo migrates once, from the stored version to the current one: each step runs in turn. */
export async function migrateSettings(values: unknown, fromVersion: number): Promise<unknown> {
  if (values === null || typeof values !== "object") return values;
  let migrated = values as Record<string, unknown>;
  if (fromVersion < 2) migrated = await keyByRepository(migrated);
  if (fromVersion < 3) migrated = withoutSharedSettings(migrated);
  return migrated;
}

/**
 * Version 3 stops sharing your `settings.json`: Claude rewrites it by renaming a new file over it,
 * which a sandbox's file mount cannot follow. A list still at the old default moves to the new
 * one; a list you changed stays as you left it (its files are copied now, so renames are safe).
 */
function withoutSharedSettings(values: Record<string, unknown>): Record<string, unknown> {
  const shared = values.claudeShared;
  if (!Array.isArray(shared)) return values;
  const legacy = new Set(LEGACY_CLAUDE_SHARED);
  const atLegacyDefault = shared.length === legacy.size && shared.every((item) => legacy.has(item));
  return atLegacyDefault ? { ...values, claudeShared: [...DEFAULT_CLAUDE_SHARED] } : values;
}

/**
 * Version 1 kept per-sandbox `overrides` keyed `directory:<path>` or `workspace:<id>`; version 2
 * keys settings by repository. A directory override moves to its repo unless another override
 * of the same repo disagrees. Workspace overrides cannot be resolved here. Everything that does
 * not move lands in `legacyOverrides`, which the Docker Sandboxes screen lists for you to reassign.
 */
async function keyByRepository(values: Record<string, unknown>): Promise<Record<string, unknown>> {
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
