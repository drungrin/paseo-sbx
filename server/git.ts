import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";

/** Runs git in `cwd`; null on any failure or empty output. */
export function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 10_000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

export function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path.replace(/\/+$/, "") || "/";
  }
}
