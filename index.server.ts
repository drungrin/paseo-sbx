import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mcpChoicesKey } from "./shared/mcp";
import { sandboxSettings, type SandboxSettings } from "./shared/settings";
import { gsdSessionsKey, reconcileGsdSessionDirs } from "./server/gsd-sessions";
import { registerHandlers } from "./server/handlers";
import { registerHooks } from "./server/hooks";
import { applyMcpChoices } from "./server/mcp";
import { cancelAllSignIns } from "./server/mcp-signin";
import { installBinFiles, pluginPaths } from "./server/paths";
import { migrateSettings } from "./server/settings-migration";
import { reconcileRecreatingMarkers } from "./server/state";

export default function contribute(server: PluginServerContext) {
  const paths = pluginPaths();
  installBinFiles(paths);
  for (const name of reconcileRecreatingMarkers(paths)) {
    console.warn(`[paseo-sbx] ${name}: a recreation was interrupted; its next launch creates it again`);
  }
  const settings = server.registerSettings({ ...sandboxSettings, migrate: migrateSettings });

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

  // GSD Path's config gets the sandboxes' session folders: at start, for each new sandbox and when
  // the integration's settings change. Updates run one after another.
  let gsdUpdates = Promise.resolve();
  function updateGsdSessions(values?: SandboxSettings): Promise<void> {
    gsdUpdates = gsdUpdates
      .then(async () => {
        const result = reconcileGsdSessionDirs(paths, values ?? (await readSettings()));
        if (result.status === "invalid-config") {
          console.warn(`[paseo-sbx] GSD Path config ${result.configPath} is unreadable (${result.error}); session folders not listed`);
        }
      })
      .catch((error) => console.warn(`[paseo-sbx] listing session folders for GSD Path: ${error instanceof Error ? error.message : error}`));
    return gsdUpdates;
  }

  const deps = { paths, readSettings, updateGsdSessions: () => updateGsdSessions() };
  registerHooks(server, deps);
  registerHandlers(server, deps);

  // A changed MCP choice reaches the existing sandboxes at once, one change after another. The
  // choices at startup are only recorded: launches bring each sandbox to them (the wrapper).
  let mcpKey: string | null = null;
  let gsdKey: string | null = null;
  let applying = Promise.resolve();
  void settings.read().then((state) => {
    if (state.status !== "ready") return;
    mcpKey ??= mcpChoicesKey(state.values);
    gsdKey ??= gsdSessionsKey(state.values);
    void updateGsdSessions(state.values);
  });
  const unsubscribe = settings.subscribe((state) => {
    if (state.status !== "ready") return;
    const gsd = gsdSessionsKey(state.values);
    if (gsd !== gsdKey) {
      gsdKey = gsd;
      void updateGsdSessions(state.values);
    }
    const key = mcpChoicesKey(state.values);
    if (key === mcpKey) return;
    mcpKey = key;
    applying = applying
      .then(() => applyMcpChoices(paths, state.values))
      .catch((error) => console.warn(`[paseo-sbx] applying MCP choices: ${error instanceof Error ? error.message : error}`));
  });
  return () => {
    unsubscribe();
    cancelAllSignIns();
  };
}
