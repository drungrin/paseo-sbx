import type { PluginServerContext } from "@getpaseo/plugin/server";
import { sandboxSettings, sandboxSettingsSchema, type SandboxSettings } from "./shared/settings";
import { registerHandlers } from "./server/handlers";
import { registerHooks } from "./server/hooks";
import { installBinFiles, pluginPaths } from "./server/paths";

export default function contribute(server: PluginServerContext) {
  const paths = pluginPaths();
  installBinFiles(paths);
  const settings = server.registerSettings(sandboxSettings);

  // Invalid stored settings must not break session launches: fall back to the defaults.
  async function readSettings(): Promise<SandboxSettings> {
    const state = await settings.read();
    if (state.status === "ready") return state.values;
    console.warn(`[paseo-sbx] invalid settings, using defaults: ${state.error}`);
    return sandboxSettingsSchema.parse({});
  }

  registerHooks(server, { paths, readSettings });
  registerHandlers(server, { paths, readSettings });
  return () => {};
}
