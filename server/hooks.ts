import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentByProvider } from "../shared/agents";
import type { SandboxSettings } from "../shared/settings";
import { PROVIDER_ID, SPEC_ENV, isExcluded } from "../shared/spec";
import { readBinding, writeBinding } from "./bindings";
import { daemonPort } from "./daemon";
import type { PluginPaths } from "./paths";
import { ensureProvider } from "./provider";
import { storedSecrets } from "./sbx";
import { buildSpec, copyHostTranscripts } from "./spec-builder";
import { rememberWorkspaceSandbox } from "./workspaces";

export interface ServerDeps {
  paths: PluginPaths;
  /** Throws when the stored settings are invalid and no valid settings were read before. */
  readSettings(): Promise<SandboxSettings>;
}

export function registerHooks(server: PluginServerContext, deps: ServerDeps): void {
  // Every session of a sandboxed agent (create, resume, refresh, import) gets its spec here; the
  // wrapper refuses to run a session without one. A throw fails the session.
  server.before("agent.session_open", async ({ request }) => {
    const agent = agentByProvider(request.provider);
    if (!agent) return request;
    const binding = readBinding(deps.paths, request.agentId);
    const home = agent.sharedHome ? join(deps.paths.homesDir, agent.sharedHome.dir) : null;
    if (request.purpose === "history") {
      // Claude's history is files: point Paseo at the transcripts and run nothing.
      if (agent.id === "claude") {
        return binding ? { ...request, env: { ...request.env, CLAUDE_CONFIG_DIR: binding.claudeConfigDir } } : request;
      }
      // Other agents read history through their CLI. Their threads live in the shared home, which
      // the catalog sandbox mounts too: reading them there leaves the workspace's VM alone.
      return {
        ...request,
        env: { ...request.env, PASEO_SBX_ROUTE: "catalog", ...(home && agent.sharedHome ? { [agent.sharedHome.env]: home } : {}) },
      };
    }
    const settings = await deps.readSettings();
    const secrets = await storedSecrets(deps.paths).catch((error: unknown) => {
      console.warn(`[paseo-sbx] could not list sbx secrets: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    const { spec, missingEnv, rejectedEnv } = await buildSpec({
      settings,
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      paths: deps.paths,
      binding,
      agent: agent.id,
      daemonPort: daemonPort(),
      secrets,
    });
    if (!binding) {
      rememberWorkspaceSandbox(deps.paths, request.workspaceId, spec);
      writeBinding(deps.paths, request.agentId, {
        key: spec.key,
        name: spec.name,
        claudeConfigDir: spec.claudeConfigDir,
      });
    }
    if (request.reason === "import" && agent.id === "claude") {
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
      // Paseo reads on the host what these name: Claude's transcripts, Codex's prompts and skills.
      env: {
        ...request.env,
        [SPEC_ENV]: JSON.stringify(spec),
        CLAUDE_CONFIG_DIR: spec.claudeConfigDir,
        ...(spec.agentHome ? { [spec.agentHome.env]: spec.agentHome.path } : {}),
      },
    };
  });

  // Internal helper agents skip this hook, so they keep their configured provider.
  server.before("agent.create", async ({ request }, context) => {
    if (request.config.provider !== "claude") return request;
    const settings = await deps.readSettings();
    if (!settings.routeClaudeAgents) return request;
    if (isExcluded(request.config.cwd, settings.excludedPaths, homedir())) return request;
    await ensureProvider(context.paseo, deps.paths, "claude");
    return { ...request, config: { ...request.config, provider: PROVIDER_ID } };
  });
}
