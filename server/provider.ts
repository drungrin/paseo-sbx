import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AGENTS, AGENT_IDS, type AgentId } from "../shared/agents";
import type { SandboxSettings } from "../shared/settings";
import { agentLauncher, type PluginPaths } from "./paths";

type PaseoApi = PluginHandlerContext["paseo"];

export interface ProviderStatus {
  configured: boolean;
  current: boolean;
}

function requiredFields(paths: PluginPaths, agent: AgentId) {
  return { extends: AGENTS[agent].extends, command: [agentLauncher(paths, agent)] };
}

function isCurrent(entry: unknown, paths: PluginPaths, agent: AgentId): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const record = entry as { extends?: unknown; command?: unknown; enabled?: unknown };
  const desired = requiredFields(paths, agent);
  return (
    record.enabled !== false &&
    record.extends === desired.extends &&
    JSON.stringify(record.command) === JSON.stringify(desired.command)
  );
}

export async function providerStatus(paseo: PaseoApi, paths: PluginPaths, agent: AgentId): Promise<ProviderStatus> {
  const { config } = await paseo.config.get();
  const entry: unknown = config.providers?.[AGENTS[agent].providerId];
  return { configured: entry !== undefined, current: isCurrent(entry, paths, agent) };
}

/**
 * Registers an agent's sandboxed provider, extending Paseo's own integration of that agent, and
 * keeps fields the user customized (label, env, models). Provider config is runtime-safe: the
 * daemon picks it up without a restart. Removing the plugin leaves the entry in place, where
 * sessions fail closed with a message naming the plugin.
 */
export async function ensureProvider(paseo: PaseoApi, paths: PluginPaths, agent: AgentId): Promise<ProviderStatus> {
  const { providerId, label, description } = AGENTS[agent];
  const { config } = await paseo.config.get();
  const existing: unknown = config.providers?.[providerId];
  if (isCurrent(existing, paths, agent)) return { configured: true, current: true };
  const base = existing !== null && typeof existing === "object" ? existing : { label, description };
  await paseo.config.patch({
    providers: { [providerId]: { ...base, ...requiredFields(paths, agent), enabled: true } },
  });
  return providerStatus(paseo, paths, agent);
}

/**
 * Turns off the providers of agents the settings no longer enable. They stay registered, disabled:
 * agents created with them keep resolving their provider, and turning one back on keeps what
 * you customized. Only the plugin's own entries are touched.
 */
export async function disableUnusedProviders(paseo: PaseoApi, settings: SandboxSettings): Promise<void> {
  const { config } = await paseo.config.get();
  const off: Record<string, { enabled: boolean }> = {};
  for (const agent of AGENT_IDS) {
    if (settings.enabledAgents.includes(agent)) continue;
    const entry: unknown = config.providers?.[AGENTS[agent].providerId];
    if (entry !== null && typeof entry === "object" && (entry as { enabled?: unknown }).enabled !== false) {
      off[AGENTS[agent].providerId] = Object.assign({}, entry, { enabled: false });
    }
  }
  if (Object.keys(off).length > 0) await paseo.config.patch({ providers: off });
}
