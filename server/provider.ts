import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { PROVIDER_ID } from "../shared/spec";
import type { PluginPaths } from "./paths";

type PaseoApi = PluginHandlerContext["paseo"];

export interface ProviderStatus {
  configured: boolean;
  current: boolean;
}

function desiredEntry(paths: PluginPaths) {
  return {
    extends: "claude",
    label: "Claude (sandbox)",
    description: "Claude Code running in this workspace's Docker Sandboxes microVM",
    // The daemon's own node runs the wrapper; no PATH lookup for an interpreter.
    command: [process.execPath, paths.wrapper],
  };
}

function isCurrent(entry: unknown, paths: PluginPaths): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const record = entry as { extends?: unknown; command?: unknown };
  const desired = desiredEntry(paths);
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
 * Registers `claude-sbx` as a custom provider extending the built-in Claude integration.
 * Provider config is runtime-safe: the daemon picks it up without a restart.
 */
export async function ensureProvider(paseo: PaseoApi, paths: PluginPaths): Promise<ProviderStatus> {
  const status = await providerStatus(paseo, paths);
  if (status.current) return status;
  await paseo.config.patch({ providers: { [PROVIDER_ID]: desiredEntry(paths) } });
  return providerStatus(paseo, paths);
}
