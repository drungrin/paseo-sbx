import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import type { SandboxSettings } from "../shared/settings";
import { PROVIDER_ID, SPEC_ENV, isExcluded } from "../shared/spec";
import { readBinding, writeBinding } from "./bindings";
import type { PluginPaths } from "./paths";
import { ensureProvider } from "./provider";
import { buildSpec, copyHostTranscripts } from "./spec-builder";

export interface ServerDeps {
  paths: PluginPaths;
  /** Throws when the stored settings are invalid and no valid settings were read before. */
  readSettings(): Promise<SandboxSettings>;
}

export function registerHooks(server: PluginServerContext, deps: ServerDeps): void {
  // Every claude-sbx session opening (create, resume, refresh, import, history) gets its spec
  // here; the wrapper refuses to run a session without one. A throw fails the session.
  server.before("agent.session_open", async ({ request }) => {
    if (request.provider !== PROVIDER_ID) return request;
    const settings = await deps.readSettings();
    const binding = readBinding(deps.paths, request.agentId);
    const { spec, missingEnv, rejectedEnv } = await buildSpec({
      settings,
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      paths: deps.paths,
      binding,
    });
    if (!binding) {
      writeBinding(deps.paths, request.agentId, {
        key: spec.key,
        name: spec.name,
        claudeConfigDir: spec.claudeConfigDir,
      });
    }
    if (request.reason === "import") {
      copyHostTranscripts(deps.paths.hostClaudeDir, request.cwd, spec.claudeConfigDir);
    }
    if (missingEnv.length > 0) {
      console.warn(`[paseo-sbx] ${spec.name}: no value for ${missingEnv.join(", ")}`);
    }
    if (rejectedEnv.length > 0) {
      console.warn(`[paseo-sbx] ${spec.name}: not forwarding reserved ${rejectedEnv.join(", ")}`);
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
