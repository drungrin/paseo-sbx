import type { Tone } from "./kit";

/** `docker.io/library/name:tag` as `name:tag`, the way you typed it. */
export function shortRef(ref: string): string {
  return ref.replace(/^docker\.io\/library\//, "");
}

/** A repository key as its path: `git:/p/app/.git` → `/p/app`. */
export function repoPath(repoKey: string): string {
  return repoKey.replace(/^(git|dir):/, "").replace(/\/\.git$/, "");
}

/** The last segment of a path. */
export function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** `/home/me/x` as `~/x` when it is under the home `/home/me`. */
export function tildify(path: string, home: string | null): string {
  if (!home) return path;
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The home directory a host path sits under, read from a path that is known to be in it. */
export function homeOf(path: string): string | null {
  return /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?:\/|$)/.exec(path)?.[1] ?? null;
}

type AgentLike = { archived: boolean; activeTurn: boolean; status: string };

/** An agent's state in a word: working, idle, or its status when it is neither. */
export function agentState(agent: AgentLike): string {
  if (agent.archived) return "Archived";
  if (agent.activeTurn) return "Working";
  return agent.status === "idle" ? "Idle" : `Idle · ${agent.status}`;
}

export function agentTone(agent: AgentLike): Tone {
  if (agent.archived) return "neutral";
  if (agent.activeTurn) return "accent";
  return agent.status === "error" ? "danger" : "neutral";
}

/** A sandbox's status as sbx reports it, in words and a tone. */
export function sandboxStatus(status: string | null): { label: string; tone: Tone; moving: boolean } {
  if (status === null) return { label: "Not created", tone: "neutral", moving: false };
  if (status === "running") return { label: "Running", tone: "success", moving: true };
  if (status === "stopped" || status === "exited") return { label: "Stopped", tone: "neutral", moving: false };
  return { label: status[0].toUpperCase() + status.slice(1), tone: "warning", moving: false };
}

export function formatMiB(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GiB` : `${Math.round(mib)} MiB`;
}

/** sbx's memory flag (`8192m`, `6g`) in MiB; null when unreadable. */
export function parseMemoryFlag(value: string | null): number | null {
  const match = /^(\d+(?:\.\d+)?)([mg])$/i.exec(value ?? "");
  if (!match) return null;
  return Number(match[1]) * (match[2].toLowerCase() === "g" ? 1024 : 1);
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** An operation kind (`save-template`) as words (`Save template`). */
export function operationLabel(kind: string): string {
  const words = kind.replace(/[._-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Operation";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
