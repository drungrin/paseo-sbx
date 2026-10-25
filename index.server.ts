import type { PluginServerContext } from "@getpaseo/plugin/server";
import { sandboxSettings, type SandboxSettings } from "./shared/settings";
import { registerHandlers } from "./server/handlers";
import { registerHooks } from "./server/hooks";
import { installBinFiles, pluginPaths } from "./server/paths";

export default function contribute(server: PluginServerContext) {
  const paths = pluginPaths();
  installBinFiles(paths);
  const settings = server.registerSettings(sandboxSettings);

  // Invalid stored settings never fall back to defaults: that could silently turn routing off
  // or reopen the network policy. Keep the last valid values for this process, else fail.
  let lastValid: SandboxSettings | null = null;
  async function readSettings(): Promise<SandboxSettings> {
    const state = await settings.read();
    if (state.status === "ready") {
      lastValid = state.values;
      return state.values;
    }
    if (lastValid) {
      console.warn(`[paseo-sbx] invalid settings, keeping the last valid ones: ${state.error}`);
      return lastValid;
    }
    throw new Error(
      `paseo-sbx settings are invalid (${state.error}). Fix or reset them in Settings > Plugins > Sandboxes.`,
    );
  }

  registerHooks(server, { paths, readSettings });
  registerHandlers(server, { paths, readSettings });
  return () => {};
}
