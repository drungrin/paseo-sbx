import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface GsdPathMember {
  name: string;
  path: string;
}

/** A repository installs GSD Path with a `.gsd-path/` dir; its runtime and worktrees live in `~/.gsd-path`. */
export function usesGsdPath(root: string): boolean {
  return existsSync(join(root, ".gsd-path"));
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

/**
 * The members a GSD Path coordinator lists in `.project/MEMBERS.md`, which its `members.py` writes in
 * a fixed format: a `## <name>` section per member with a `Checkout: <path>` line. Same reading as
 * paseo-commit-graph's.
 */
export function gsdPathMembers(root: string, home: string): GsdPathMember[] {
  let text: string;
  try {
    text = readFileSync(join(root, ".project", "MEMBERS.md"), "utf8");
  } catch {
    return [];
  }
  const members: GsdPathMember[] = [];
  let name: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      name = heading[1];
      continue;
    }
    const checkout = /^Checkout:\s*(.+?)\s*$/.exec(line);
    if (checkout && name) {
      members.push({ name, path: resolve(root, expandHome(checkout[1], home)) });
      name = undefined;
    }
  }
  return members;
}
