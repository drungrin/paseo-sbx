import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { BoundAgentInfo } from "../shared/rpc";
import type { PluginPaths } from "./paths";

type PaseoApi = PluginHandlerContext["paseo"];

/** Sandbox name → ids of the agents bound to it. Bindings of archived agents stay for their history. */
export function bindingsBySandbox(paths: PluginPaths): Map<string, string[]> {
  const bySandbox = new Map<string, string[]>();
  let entries: string[] = [];
  try {
    entries = readdirSync(paths.bindingsDir);
  } catch {
    return bySandbox;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const binding = JSON.parse(readFileSync(join(paths.bindingsDir, entry), "utf8")) as { name?: unknown };
      if (typeof binding.name !== "string") continue;
      const ids = bySandbox.get(binding.name) ?? [];
      ids.push(entry.slice(0, -".json".length));
      bySandbox.set(binding.name, ids);
    } catch {
      // unreadable binding: ignore
    }
  }
  return bySandbox;
}

/**
 * Sandbox name → its agents that are not archived. One paged listing of the daemon's live agents
 * (archived ones are excluded by default), matched against the bindings: the cost stays flat as
 * bindings of archived agents accumulate.
 */
export async function activeAgentsBySandbox(paths: PluginPaths, paseo: PaseoApi): Promise<Map<string, BoundAgentInfo[]>> {
  const sandboxByAgent = new Map<string, string>();
  for (const [name, ids] of bindingsBySandbox(paths)) for (const id of ids) sandboxByAgent.set(id, name);
  const result = new Map<string, BoundAgentInfo[]>();
  if (sandboxByAgent.size === 0) return result;
  let cursor: string | undefined;
  for (;;) {
    const page = await paseo.agents.list({ page: cursor ? { limit: 200, cursor } : { limit: 200 } });
    for (const { agent } of page.entries) {
      const name = sandboxByAgent.get(agent.id);
      if (!name || agent.archivedAt) continue;
      const list = result.get(name) ?? [];
      list.push({
        id: agent.id,
        title: agent.title ?? null,
        status: agent.status,
        activeTurn: Boolean(agent.activeTurn),
        archived: false,
        updatedAt: agent.updatedAt ?? null,
      });
      result.set(name, list);
    }
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) return result;
    cursor = page.pageInfo.nextCursor;
  }
}
