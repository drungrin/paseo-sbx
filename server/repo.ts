import { basename, dirname } from "node:path";
import { canonical, git } from "./git";

export interface RepoIdentity {
  /** `git:<canonical common dir>`, or `dir:<canonical path>` outside git. */
  key: string;
  /** Directory shown for the repo: the main worktree, or the common dir of a bare repo. */
  root: string;
}

/**
 * Worktrees of one repository share its git common dir, so they share a key; each submodule
 * has its own (`.git/modules/<name>`) and a bare repository is its own common dir.
 */
export async function repoIdentity(cwd: string): Promise<RepoIdentity> {
  const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!commonDir) {
    const path = canonical(cwd);
    return { key: `dir:${path}`, root: path };
  }
  const common = canonical(commonDir);
  if (basename(common) === ".git") return { key: `git:${common}`, root: dirname(common) };
  const toplevel = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return { key: `git:${common}`, root: toplevel ? canonical(toplevel) : common };
}

/** Name of the repo for display: its root's last path element without a `.git` suffix. */
export function repoDisplayName(identity: RepoIdentity): string {
  return basename(identity.root).replace(/\.git$/, "") || identity.root;
}
