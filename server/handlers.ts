import type { PluginServerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import {
  addMcpServerRpc,
  cancelMcpSignInRpc,
  configureAgentRpc,
  describeSandboxRpc,
  finishMcpSignInRpc,
  finishTemplateRpc,
  getMcpSignInRpc,
  getOperationRpc,
  listMcpServersRpc,
  listSandboxesRpc,
  listTemplatesRpc,
  memoryRpc,
  prepareTemplateRpc,
  publishPortRpc,
  removeMcpServerRpc,
  removeTemplateRpc,
  sandboxActionRpc,
  saveTemplateRpc,
  shellCommandRpc,
  startMcpSignInRpc,
  statusRpc,
  unpublishPortRpc,
} from "../shared/rpc";
import type { SandboxSettings } from "../shared/settings";
import { formatMount, isReservedEnvName, memoryMiB, templatePrepName, type SandboxSpec } from "../shared/spec";
import type { ServerDeps } from "./hooks";
import { AGENTS, AGENT_IDS } from "../shared/agents";
import { catalogName } from "../shared/spec";
import { catalogStatus, ensureCatalog } from "./catalog";
import { disableUnusedProviders, ensureProvider, providerStatus } from "./provider";
import { activeAgentsBySandbox } from "./agents";
import { addMcpServer, listMcpServers, readLoadedMcp, removeMcpServer } from "./mcp";
import { cancelSignIn, finishSignIn, getSignIn, startSignIn } from "./mcp-signin";
import { hostMemory, memoryAlerts, vmMemoryMiB } from "./memory";
import { getOperation, operationsFor, runOperation } from "./operations";
import { actualPublications, internalPorts, publishPort, readListeners, unpublishPort } from "./ports";
import { recreateBlockers, recreateSandbox } from "./recreate";
import { repoDisplayName, repoIdentity } from "./repo";
import { listSandboxes, prepareSandbox, removeSandbox, sbxHealth, shellCommand, stopSandbox } from "./sbx";
import { buildSpec, envFilePath, forwardedEnvNames, readEnvFile, templateFor } from "./spec-builder";
import { readSandboxState, type SandboxState } from "./state";
import {
  ensureTemplatePrep,
  findTemplate,
  finishTemplatePrep,
  listTemplates,
  removeTemplate,
  saveTemplate,
  templateSandboxes,
  templateUsers,
  type TemplateInfo,
} from "./templates";

/**
 * Whether the sandbox has the memory, CPUs and Docker disk the settings select now; null when its
 * record predates them. CPUs are compared only once recorded; a sandbox without a recorded disk was
 * created before the plugin sized it, with sbx's.
 */
function resourcesApplied(state: SandboxState | null, spec: SandboxSpec): boolean | null {
  if (!state?.memory) return null;
  if (state.memory !== spec.memory) return false;
  if (state.cpus !== undefined && state.cpus !== spec.cpus) return false;
  if ((state.dockerDisk ?? null) !== spec.dockerDisk) return false;
  return true;
}

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
    await disableUnusedProviders(paseo, settings);
    const sbx = await sbxHealth(paths);
    const agents = await Promise.all(
      AGENT_IDS.map(async (id) => {
        const [provider, catalog] = await Promise.all([providerStatus(paseo, paths, id), catalogStatus(paths, id)]);
        return {
          id,
          label: AGENTS[id].label,
          providerId: AGENTS[id].providerId,
          enabled: settings.enabledAgents.includes(id),
          provider,
          catalog: {
            name: catalog.name,
            exists: catalog.exists,
            cliVersion: catalog.record?.cliVersion ?? null,
            createdAt: catalog.record?.createdAt ?? null,
          },
          login: catalog.login,
          install: AGENTS[id].install,
        };
      }),
    );
    return {
      sbx,
      agents,
      stateHome: paths.stateHome,
      wrapperPath: paths.wrapper,
      envFile: envFilePath(settings, paths),
      hostMemoryMiB: Math.round(totalmem() / 1024 / 1024),
      hostCpus: availableParallelism(),
      defaultMemoryMiB: memoryMiB(settings, undefined, totalmem()),
    };
  });

  server.handle(configureAgentRpc, async ({ agent, update }, { paseo }) => {
    const settings = await deps.readSettings();
    if (!settings.enabledAgents.includes(agent)) throw new Error(`${AGENTS[agent].label} is off: turn it on in the plugin settings`);
    return runOperation(update ? "update" : "configure", catalogName(agent, paths.stateHome), async () => {
      await ensureProvider(paseo, paths, agent);
      const record = await ensureCatalog(paths, settings, agent, { update });
      return { cliVersion: record.cliVersion };
    }, 0);
  });

  server.handle(listSandboxesRpc, async () => ({ sandboxes: await listSandboxes(paths) }));

  server.handle(describeSandboxRpc, async ({ workspaceId, directory }, { paseo }) => {
    const settings = await deps.readSettings();
    const built = await buildSpec({ settings, workspaceId, cwd: directory, paths, prepare: false });
    const { spec } = built;
    const [sandboxes, templates, repo] = await Promise.all([
      listSandboxes(paths),
      listTemplates(paths),
      repoIdentity(directory),
    ]);
    const fileValues = readEnvFile(envFilePath(settings, paths));
    const sandbox = sandboxes.find((entry) => entry.name === spec.name);
    const state = readSandboxState(paths, spec.name);
    const created = sandbox && state?.mounts ? new Set(state.mounts) : null;
    return {
      key: spec.key,
      name: spec.name,
      status: sandbox?.status ?? null,
      repoKey: spec.repoKey,
      repoName: repoDisplayName(repo),
      memoryMiB: Number.parseInt(spec.memory, 10),
      repoMemoryGiB: settings.repos[spec.repoKey]?.memoryGiB ?? null,
      cpus: spec.cpus,
      repoCpus: settings.repos[spec.repoKey]?.cpus ?? null,
      resourcesApplied: sandbox ? resourcesApplied(state, spec) : null,
      rssMiB: sandbox?.status === "running" ? (vmMemoryMiB(paths).get(spec.name) ?? null) : null,
      workspace: spec.workspace,
      mounts: built.mounts.map((mount) => ({
        path: mount.path,
        readOnly: mount.readOnly,
        source: mount.source,
        exists: existsSync(mount.path),
        applied: created ? created.has(formatMount(mount)) : null,
      })),
      removedMounts: created ? [...created].filter((entry) => !spec.mounts.includes(entry)) : [],
      gsdPath: built.gsdPath && {
        enabled: built.gsdPath.enabled,
        members: built.gsdPath.members.map((member) => ({ ...member, available: existsSync(member.path) })),
      },
      env: forwardedEnvNames(settings, spec.repoKey).map((name) => ({
        name,
        scope: settings.envNames.includes(name) ? ("all" as const) : ("repo" as const),
        present: fileValues[name] !== undefined || process.env[name] !== undefined,
        reserved: isReservedEnvName(name),
      })),
      template: templateStatus(settings, spec.repoKey, state, templates),
      agents: (await activeAgentsBySandbox(paths, paseo)).get(spec.name) ?? [],
      recreateBlockers: sandbox ? await recreateBlockers(paths, paseo, spec.name) : ["the sandbox does not exist yet"],
      templatePrep:
        sandboxes.find((entry) => entry.kind === "template-prep" && entry.repoKey === spec.repoKey)?.name ?? null,
      siblings: sandboxes
        .filter((entry) => entry.kind === "working" && entry.repoKey === spec.repoKey && entry.name !== spec.name)
        .map((entry) => entry.name),
      operations: operationsFor([spec.name, templatePrepName(repo.key, repo.root)]),
      services: await services(spec.name, spec.claudeConfigDir, Boolean(sandbox)),
      mcp: mcpState(spec.name, spec.mcpServers ?? [], sandbox?.status ?? null, state),
    };
  });

  /** What the sandbox's gateway has against the repository's MCP choices; nothing before it exists. */
  function mcpState(name: string, autoLoad: string[], status: string | null, state: SandboxState | null) {
    const exists = status !== null;
    const record = exists ? readLoadedMcp(paths, name, status === "running") : { loaded: [], unreadable: null };
    return {
      autoLoad,
      loaded: record.loaded,
      unreadable: record.unreadable,
      pendingUnload: exists ? (state?.mcpUnload ?? []) : [],
      errors: exists ? (state?.mcpErrors ?? {}) : {},
    };
  }

  async function services(name: string, claudeConfigDir: string, exists: boolean) {
    const state = readSandboxState(paths, name);
    const snapshot = readListeners(claudeConfigDir);
    const hidden = new Set([...internalPorts(claudeConfigDir), ...(state?.publications ?? []).map((entry) => entry.relayPort)]);
    const actual = exists ? await actualPublications(deps, name) : [];
    return {
      snapshotAt: snapshot?.at ?? null,
      listeners: (snapshot?.listeners ?? []).filter((listener) => !hidden.has(listener.port)),
      publications: (state?.publications ?? []).map((publication) => ({
        guestPort: publication.guestPort,
        allInterfaces: publication.allInterfaces,
        reserved: publication.reserved,
        auto: publication.auto ?? false,
        hostPort:
          actual.find(
            (entry) =>
              entry.sandbox_port === publication.relayPort &&
              entry.host_ip === (publication.allInterfaces ? "0.0.0.0" : "127.0.0.1"),
          )?.host_port ?? null,
      })),
    };
  }

  server.handle(publishPortRpc, (input, { paseo }) =>
    runOperation("publish", input.name, async () => {
      await publishPort(deps, paseo, input);
      return null;
    }),
  );

  server.handle(unpublishPortRpc, ({ name, guestPort }) =>
    runOperation("unpublish", name, async () => {
      await unpublishPort(deps, name, guestPort);
      return null;
    }),
  );

  server.handle(getOperationRpc, ({ id }) => getOperation(id));

  server.handle(sandboxActionRpc, ({ name, action }, { paseo }) =>
    runOperation(action, name, async () => {
      if (action === "stop") return stopSandbox(paths, name);
      if (action === "remove") await removeSandbox(paths, name);
      else await recreateSandbox(deps, paseo, name);
      return null;
    }),
  );

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
    return runOperation("prepare", spec.name, async () => {
      await prepareSandbox(paths, spec);
      return { name: spec.name, ...shellCommand(paths, spec.name, { homeMounts: spec.homeMounts }) };
    });
  });

  server.handle(listTemplatesRpc, async () => {
    const settings = await deps.readSettings();
    const [templates, sandboxes] = await Promise.all([listTemplates(paths), listSandboxes(paths)]);
    const names = sandboxes.map((sandbox) => sandbox.name);
    return {
      templates: templates.map((template) => ({
        ...template,
        users: templateUsers(settings, template.ref),
        sandboxes: templateSandboxes(paths, names, template),
      })),
    };
  });

  server.handle(saveTemplateRpc, ({ name, tag }) =>
    runOperation("save-template", name, async () => ({ ref: await saveTemplate(paths, name, tag) })),
  );

  server.handle(removeTemplateRpc, async ({ ref }) => {
    await removeTemplate(paths, await deps.readSettings(), ref);
    return { ok: true as const };
  });

  server.handle(prepareTemplateRpc, async ({ directory }) => {
    const repo = await repoIdentity(directory);
    return runOperation("prepare-template", templatePrepName(repo.key, repo.root), async () => {
      const prep = await ensureTemplatePrep(deps, directory);
      return { name: prep.name, repoKey: prep.repoKey, ...shellCommand(paths, prep.name, { noHistory: true }) };
    });
  });

  server.handle(finishTemplateRpc, ({ name, tag }) =>
    runOperation("save-template", name, async () => ({ ref: await finishTemplatePrep(paths, name, tag) })),
  );

  server.handle(listMcpServersRpc, () => listMcpServers(paths));

  server.handle(addMcpServerRpc, (input) => addMcpServer(paths, input));

  server.handle(removeMcpServerRpc, async ({ name }) => {
    await removeMcpServer(paths, name);
    return { ok: true as const };
  });

  server.handle(startMcpSignInRpc, ({ server: name }) => startSignIn(paths, name));

  server.handle(getMcpSignInRpc, ({ id }) => getSignIn(id));

  server.handle(finishMcpSignInRpc, ({ id, callbackUrl }) => finishSignIn(id, callbackUrl));

  server.handle(cancelMcpSignInRpc, ({ id }) => {
    cancelSignIn(id);
    return { ok: true as const };
  });
}
