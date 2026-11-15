import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";

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

/**
 * The remotes of the repository at `root` that git reaches by a local path (`/srv/app.git`,
 * `file:///srv/app.git`, `../app.git`), absolute and existing on the host. Relative ones resolve
 * against `root`, as git resolves them from the worktree's top. URLs with a scheme or the scp form
 * (`host:path`) are network remotes and left out.
 */
export async function localRemotePaths(root: string): Promise<string[]> {
  const output = await git(root, ["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"]);
  if (!output) return [];
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    const url = line.slice(line.indexOf(" ") + 1).trim();
    const path = localRemotePath(url, root);
    if (path && existsSync(path)) paths.add(path);
  }
  return [...paths];
}

export function localRemotePath(url: string, root: string): string | null {
  if (!url) return null;
  if (url.startsWith("file://")) {
    let path: string;
    try {
      path = decodeURIComponent(url.slice("file://".length));
    } catch {
      return null;
    }
    return path.startsWith("/") ? normalize(path).replace(/\/+$/, "") || "/" : null;
  }
  if (url.includes("://")) return null;
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  // `host:path` is ssh, unless a slash comes before the colon (`./a:b`).
  if (colon !== -1 && (slash === -1 || colon < slash)) return null;
  return resolve(root, url).replace(/\/+$/, "") || "/";
}
