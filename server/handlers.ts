import type { PluginServerContext } from "@getpaseo/plugin/server";
import { totalmem } from "node:os";
import {
  describeSandboxRpc,
  ensureProviderRpc,
  listSandboxesRpc,
  sandboxActionRpc,
  shellCommandRpc,
  statusRpc,
} from "../shared/rpc";
import { memoryMiB } from "../shared/spec";
import type { ServerDeps } from "./hooks";
import { ensureProvider, providerStatus } from "./provider";
import { listSandboxes, prepareSandbox, removeSandbox, sbxHealth, shellCommand, stopSandbox } from "./sbx";
import { buildSpec, forwardedEnvNames, readEnvFile } from "./spec-builder";

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

  server.handle(describeSandboxRpc, async ({ workspaceId, directory }) => {
    const settings = await deps.readSettings();
    const { spec } = await buildSpec({ settings, workspaceId, cwd: directory, paths });
    const sandboxes = await listSandboxes(paths);
    const fileValues = readEnvFile(settings.envFile || paths.defaultEnvFile);
    return {
      key: spec.key,
      name: spec.name,
      status: sandboxes.find((sandbox) => sandbox.name === spec.name)?.status ?? null,
      memoryMiB: Number.parseInt(spec.memory, 10),
      overrideMemoryGiB: settings.overrides[spec.key]?.memoryGiB ?? null,
      mounts: [spec.workspace, ...spec.mounts],
      env: forwardedEnvNames(settings, spec.key).map((name) => ({
        name,
        present: fileValues[name] !== undefined || process.env[name] !== undefined,
      })),
    };
  });

  server.handle(sandboxActionRpc, async ({ name, action }) => {
    if (action === "stop") await stopSandbox(paths, name);
    else await removeSandbox(paths, name);
    return { ok: true as const };
  });

  // Creates the sandbox when needed so a terminal can enter it before any agent ran there.
  server.handle(shellCommandRpc, async ({ workspaceId, directory }) => {
    const settings = await deps.readSettings();
    const { spec } = await buildSpec({ settings, workspaceId, cwd: directory, paths });
    await prepareSandbox(paths, spec);
    return { name: spec.name, ...shellCommand(paths, spec.name) };
  });
}
