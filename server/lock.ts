import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginPaths } from "./paths";
import { processAlive } from "./state";

const STALE_MS = 600_000;

export function newLockToken(): string {
  return randomUUID();
}

/**
 * The wrapper's per-sandbox lock (`locks/<name>`, owner file `<pid> <token>`). A lock whose owner
 * died, or older than ten minutes, is taken over. A wrapper started with the holder's token in
 * PASEO_SBX_LOCK_TOKEN runs inside the held lock instead of waiting for it.
 */
export async function withSandboxLock<T>(
  paths: PluginPaths,
  name: string,
  token: string,
  fn: () => Promise<T>,
  timeoutMs = 180_000,
): Promise<T> {
  const dir = join(paths.locksDir, name);
  const owner = join(dir, "owner");
  const deadline = Date.now() + timeoutMs;
  mkdirSync(paths.locksDir, { recursive: true });
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(owner, `${process.pid} ${token}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ownerPid = 0;
      try {
        ownerPid = Number(readFileSync(owner, "utf8").split(" ")[0]);
      } catch {
        // owner not written yet, or released between the attempts
      }
      let stale = ownerPid > 0 && !processAlive(ownerPid);
      try {
        stale = stale || Date.now() - statSync(dir).mtimeMs > STALE_MS;
      } catch {
        continue;
      }
      if (stale) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the lock of ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
