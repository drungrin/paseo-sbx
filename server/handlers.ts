import type { PluginServerContext } from "@getpaseo/plugin/server";
import { totalmem } from "node:os";
import {
  describeSandboxRpc,
  ensureProviderRpc,
  finishTemplateRpc,
  listSandboxesRpc,
  listTemplatesRpc,
  memoryRpc,
  prepareTemplateRpc,
  removeTemplateRpc,
  sandboxActionRpc,
  saveTemplateRpc,
  shellCommandRpc,
  statusRpc,
} from "../shared/rpc";
import type { SandboxSettings } from "../shared/settings";
import { memoryMiB } from "../shared/spec";
import type { ServerDeps } from "./hooks";
import { ensureProvider, providerStatus } from "./provider";
import { activeAgentsBySandbox } from "./agents";
import { hostMemory, memoryAlerts, vmMemoryMiB } from "./memory";
import { recreateBlockers, recreateSandbox } from "./recreate";
import { repoDisplayName, repoIdentity } from "./repo";
import { listSandboxes, prepareSandbox, removeSandbox, sbxHealth, shellCommand, stopSandbox } from "./sbx";
import { buildSpec, forwardedEnvNames, readEnvFile, templateFor } from "./spec-builder";
import { readSandboxState, type SandboxState } from "./state";
import {
  ensureTemplatePrep,
  findTemplate,
  finishTemplatePrep,
  listTemplates,
  removeTemplate,
  saveTemplate,
  templateUsers,
  type TemplateInfo,
} from "./templates";

/** Compares what the repo selects now with what the sandbox was created from, by image ID. */
function templateStatus(
  settings: SandboxSettings,
  repoKey: string,
  state: SandboxState | null,
  templates: readonly TemplateInfo[],
) {
  const configured = templateFor(settings, repoKey);
  if (!state) return { configured, sandbox: null, status: "none" as const };
  if (state.template === undefined) return { configured, sandbox: null, status: "unknown" as const };
  const sandbox = state.template ?? null;
  if (configured === null || sandbox === null) {
    return { configured, sandbox, status: configured === sandbox ? ("match" as const) : ("diverged" as const) };
  }
  const configuredId = findTemplate(templates, configured)?.id;
  if (!configuredId || !state.templateImageId) return { configured, sandbox, status: "unknown" as const };
  return { configured, sandbox, status: configuredId === state.templateImageId ? ("match" as const) : ("diverged" as const) };
}

export function registerHandlers(server: PluginServerContext, deps: ServerDeps): void {
  const { paths } = deps;

  server.handle(statusRpc, async (_input, { paseo }) => {
    const settings = await deps.readSettings();
    const [sbx, provider] = await Promise.all([sbxHealth(paths), providerStatus(paseo, paths)]);
    return {
      sbx,
      provider,
      stateHome: paths.stateHome,
      wrapperPath: paths.wrapper,
      envFile: settings.envFile || paths.defaultEnvFile,
      hostMemoryMiB: Math.round(totalmem() / 1024 / 1024),
      defaultMemoryMiB: memoryMiB(settings, undefined, totalmem()),
    };
  });

  server.handle(ensureProviderRpc, (_input, { paseo }) => ensureProvider(paseo, paths));

  server.handle(listSandboxesRpc, async () => ({ sandboxes: await listSandboxes(paths) }));

  server.handle(describeSandboxRpc, async ({ workspaceId, directory }, { paseo }) => {
    const settings = await deps.readSettings();
    const { spec } = await buildSpec({ settings, workspaceId, cwd: directory, paths, prepare: false });
    const [sandboxes, templates, repo] = await Promise.all([
      listSandboxes(paths),
      listTemplates(paths),
      repoIdentity(directory),
    ]);
    const fileValues = readEnvFile(settings.envFile || paths.defaultEnvFile);
    const sandbox = sandboxes.find((entry) => entry.name === spec.name);
    return {
      key: spec.key,
      name: spec.name,
      status: sandbox?.status ?? null,
      repoKey: spec.repoKey,
      repoName: repoDisplayName(repo),
      memoryMiB: Number.parseInt(spec.memory, 10),
      repoMemoryGiB: settings.repos[spec.repoKey]?.memoryGiB ?? null,
      rssMiB: sandbox?.status === "running" ? (vmMemoryMiB(paths).get(spec.name) ?? null) : null,
      mounts: [spec.workspace, ...spec.mounts],
      env: forwardedEnvNames(settings, spec.repoKey).map((name) => ({
        name,
        present: fileValues[name] !== undefined || process.env[name] !== undefined,
      })),
      template: templateStatus(settings, spec.repoKey, readSandboxState(paths, spec.name), templates),
      agents: (await activeAgentsBySandbox(paths, paseo)).get(spec.name) ?? [],
      recreateBlockers: sandbox ? await recreateBlockers(paths, paseo, spec.name) : ["the sandbox does not exist yet"],
      templatePrep:
        sandboxes.find((entry) => entry.kind === "template-prep" && entry.repoKey === spec.repoKey)?.name ?? null,
      siblings: sandboxes
        .filter((entry) => entry.kind === "working" && entry.repoKey === spec.repoKey && entry.name !== spec.name)
        .map((entry) => entry.name),
    };
  });

  server.handle(sandboxActionRpc, async ({ name, action }, { paseo }) => {
    if (action === "stop") return { ok: true as const, graceful: (await stopSandbox(paths, name)).graceful };
    if (action === "remove") await removeSandbox(paths, name);
    else await recreateSandbox(deps, paseo, name);
    return { ok: true as const };
  });

  server.handle(memoryRpc, async (_input, { paseo }) => {
    const settings = await deps.readSettings();
    const [sandboxes, agents] = await Promise.all([listSandboxes(paths), activeAgentsBySandbox(paths, paseo)]);
    const rss = vmMemoryMiB(paths);
    const host = hostMemory();
    return {
      host,
      vmRssMiB: [...rss.values()].reduce((sum, value) => sum + value, 0),
      sandboxes: sandboxes.map((sandbox) => ({
        name: sandbox.name,
        rssMiB: sandbox.status === "running" ? (rss.get(sandbox.name) ?? null) : null,
        activeAgents: agents.get(sandbox.name) ?? [],
      })),
      alerts: host ? memoryAlerts(host, settings.memoryAlert) : [],
    };
  });

  // Creates the sandbox when needed so a terminal can enter it before any agent ran there.
  server.handle(shellCommandRpc, async ({ workspaceId, directory }) => {
    const settings = await deps.readSettings();
    const { spec } = await buildSpec({ settings, workspaceId, cwd: directory, paths });
    await prepareSandbox(paths, spec);
    return { name: spec.name, ...shellCommand(paths, spec.name) };
  });

  server.handle(listTemplatesRpc, async () => {
    const settings = await deps.readSettings();
    const templates = await listTemplates(paths);
    return { templates: templates.map((template) => ({ ...template, users: templateUsers(settings, template.ref) })) };
  });

  server.handle(saveTemplateRpc, async ({ name, tag }) => ({ ref: await saveTemplate(paths, name, tag) }));

  server.handle(removeTemplateRpc, async ({ ref }) => {
    await removeTemplate(paths, await deps.readSettings(), ref);
    return { ok: true as const };
  });

  server.handle(prepareTemplateRpc, async ({ directory }) => {
    const prep = await ensureTemplatePrep(deps, directory);
    return { name: prep.name, repoKey: prep.repoKey, ...shellCommand(paths, prep.name, { noHistory: true }) };
  });

  server.handle(finishTemplateRpc, async ({ name, tag }) => ({ ref: await finishTemplatePrep(paths, name, tag) }));
}
