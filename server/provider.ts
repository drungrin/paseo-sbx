import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { PROVIDER_ID } from "../shared/spec";
import type { PluginPaths } from "./paths";

type PaseoApi = PluginHandlerContext["paseo"];

export interface ProviderStatus {
  configured: boolean;
  current: boolean;
}

const DEFAULTS = {
  label: "Claude (sandbox)",
  description: "Claude Code running in this workspace's Docker Sandboxes microVM",
};

function requiredFields(paths: PluginPaths) {
  return { extends: "claude", command: [paths.launcher] };
}

function isCurrent(entry: unknown, paths: PluginPaths): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const record = entry as { extends?: unknown; command?: unknown };
  const desired = requiredFields(paths);
  return (
    record.extends === desired.extends &&
    JSON.stringify(record.command) === JSON.stringify(desired.command)
  );
}

export async function providerStatus(paseo: PaseoApi, paths: PluginPaths): Promise<ProviderStatus> {
  const { config } = await paseo.config.get();
  const entry: unknown = config.providers?.[PROVIDER_ID];
  return { configured: entry !== undefined, current: isCurrent(entry, paths) };
}

/**
 * Registers `claude-sbx` as a custom provider extending the built-in Claude integration, keeping
 * fields the user customized (label, env, models). Provider config is runtime-safe: the daemon
 * picks it up without a restart. Removing the plugin leaves the entry in place, where sessions
 * fail closed with a message naming the plugin.
 */
export async function ensureProvider(paseo: PaseoApi, paths: PluginPaths): Promise<ProviderStatus> {
  const { config } = await paseo.config.get();
  const existing: unknown = config.providers?.[PROVIDER_ID];
  if (isCurrent(existing, paths)) return { configured: true, current: true };
  const base = existing !== null && typeof existing === "object" ? existing : DEFAULTS;
  await paseo.config.patch({ providers: { [PROVIDER_ID]: { ...base, ...requiredFields(paths) } } });
  return providerStatus(paseo, paths);
}
