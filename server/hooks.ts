import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import type { SandboxSettings } from "../shared/settings";
import { PROVIDER_ID, SPEC_ENV, isExcluded } from "../shared/spec";
import type { PluginPaths } from "./paths";
import { ensureProvider } from "./provider";
import { buildSpec } from "./spec-builder";

export interface ServerDeps {
  paths: PluginPaths;
  readSettings(): Promise<SandboxSettings>;
}

export function registerHooks(server: PluginServerContext, deps: ServerDeps): void {
  // Every claude-sbx session opening (create, resume, refresh, import) gets its spec here.
  // The wrapper refuses to run a session without one.
  server.before("agent.session_open", async ({ request }) => {
    if (request.provider !== PROVIDER_ID) return request;
    const settings = await deps.readSettings();
    const { spec, missingEnv } = await buildSpec({
      settings,
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      paths: deps.paths,
    });
    if (missingEnv.length > 0) {
      console.warn(`[paseo-sbx] ${spec.name}: no value for ${missingEnv.join(", ")}`);
    }
    return {
      ...request,
      // CLAUDE_CONFIG_DIR is also what Paseo uses on the host to find this session's transcript.
      env: { ...request.env, [SPEC_ENV]: JSON.stringify(spec), CLAUDE_CONFIG_DIR: spec.claudeConfigDir },
    };
  });

  // Internal helper agents skip this hook, so they keep their configured provider.
  server.before("agent.create", async ({ request }, context) => {
    if (request.config.provider !== "claude") return request;
    const settings = await deps.readSettings();
    if (!settings.routeClaudeAgents) return request;
    if (isExcluded(request.config.cwd, settings.excludedPaths, homedir())) return request;
    await ensureProvider(context.paseo, deps.paths);
    return { ...request, config: { ...request.config, provider: PROVIDER_ID } };
  });
}
