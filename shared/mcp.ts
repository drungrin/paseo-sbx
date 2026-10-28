import type { SandboxSettings } from "./settings";

type McpChoices = Pick<SandboxSettings, "mcpGlobal" | "repos">;

/** Names `sbx mcp add` accepts: letters, digits, `.`, `-` and `_`. */
export const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** Header names an API key can travel in. */
export const MCP_HEADER_PATTERN = /^[A-Za-z0-9-]+$/;

/** Whether a repository's sandboxes load the server: the repository's choice, else the global one. */
export function mcpLoads(settings: McpChoices, repoKey: string, name: string): boolean {
  return settings.repos[repoKey]?.mcp?.[name] ?? settings.mcpGlobal.includes(name);
}

/** The servers the plugin loads into a repository's sandboxes, sorted. */
export function mcpAutoLoad(settings: McpChoices, repoKey: string): string[] {
  const names = new Set([...settings.mcpGlobal, ...Object.keys(settings.repos[repoKey]?.mcp ?? {})]);
  return [...names].filter((name) => mcpLoads(settings, repoKey, name)).sort();
}

/**
 * What a sandbox's gateway needs to match the repository's choices (`wanted`): load what it lacks,
 * and unload what was turned off since the plugin last applied them (`before`) or still waits
 * for it (`pending`). Servers an agent loaded itself are never in `before` and stay. With
 * `loaded` unknown (null), every wanted server is loaded again, which sbx takes as a no-op.
 * Same rule as reconcileMcp in the wrapper.
 */
export function planMcp(input: {
  wanted: readonly string[];
  before: readonly string[];
  pending: readonly string[];
  loaded: readonly string[] | null;
}): { load: string[]; unload: string[] } {
  const off = new Set([...input.pending, ...input.before].filter((name) => !input.wanted.includes(name)));
  return {
    load: input.wanted.filter((name) => !input.loaded?.includes(name)),
    unload: [...off].filter((name) => !input.loaded || input.loaded.includes(name)),
  };
}

/** Every MCP choice in the settings, as one comparable string. */
export function mcpChoicesKey(settings: McpChoices): string {
  const repos = Object.keys(settings.repos)
    .sort()
    .filter((key) => Object.keys(settings.repos[key].mcp ?? {}).length > 0)
    .map((key) => [key, settings.repos[key].mcp]);
  return JSON.stringify([[...settings.mcpGlobal].sort(), repos]);
}

const HOST_PREFIXES = new Set(["mcp", "www", "api"]);

/** A name for a server from its URL: `https://mcp.exa.ai/mcp` → `exa`. Empty when there is none. */
export function mcpNameFromUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url.trim()).hostname;
  } catch {
    return "";
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length > 1) labels.pop();
  while (labels.length > 1 && HOST_PREFIXES.has(labels[0])) labels.shift();
  return (labels[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
}
