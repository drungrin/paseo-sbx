import type { AgentId } from "../shared/agents";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  describeSandboxRpc,
  configureAgentRpc,
  getOperationRpc,
  listSandboxesRpc,
  listTemplatesRpc,
  memoryRpc,
  removeTemplateRpc,
  sandboxActionRpc,
  saveTemplateRpc,
  refResultSchema,
  statusRpc,
  type OperationView,
} from "../shared/rpc";
import { sandboxSettings, type RepoConfig } from "../shared/settings";

export function useStatus() {
  const getStatus = useRpc(statusRpc);
  return useQuery({ queryKey: ["status"], queryFn: () => getStatus({}) });
}

export function useSandboxes() {
  const list = useRpc(listSandboxesRpc);
  return useQuery({ queryKey: ["sandboxes"], queryFn: () => list({}), refetchInterval: 10_000 });
}

export type Description = z.infer<(typeof describeSandboxRpc)["output"]>;

export function useSandboxDescription(workspaceId: string, directory: string | null) {
  const describe = useRpc(describeSandboxRpc);
  return useQuery({
    queryKey: ["describe", workspaceId, directory],
    queryFn: () => describe({ workspaceId, directory: directory ?? "" }),
    enabled: directory !== null,
    refetchInterval: 10_000,
  });
}

export function useMemory() {
  const get = useRpc(memoryRpc);
  return useQuery({ queryKey: ["memory"], queryFn: () => get({}), refetchInterval: 10_000 });
}

export function useTemplates() {
  const list = useRpc(listTemplatesRpc);
  return useQuery({ queryKey: ["templates"], queryFn: () => list({}) });
}

/**
 * Waits for a sandbox operation. Slow ones (an image pull, a template save, a recreation) outlast
 * the daemon's 30 s plugin RPC limit, return as running, and are polled here.
 */
export function useAwaitOperation() {
  const get = useRpc(getOperationRpc);
  return async (start: OperationView): Promise<OperationView["result"]> => {
    let operation: OperationView | null = start;
    while (operation?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      operation = await get({ id: operation.id });
    }
    if (!operation) throw new Error("The operation was lost: the plugin restarted. Check the sandbox and try again.");
    if (operation.status === "failed") throw new Error(operation.error ?? "The operation failed.");
    return operation.result;
  };
}

const stopResultSchema = z.object({ graceful: z.boolean() });

/** Mutations change sandboxes and provider state; refresh every view of them. */
export function useInvalidateAll() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries();
}

/** Registers an agent's provider and sets up its catalog sandbox; can take minutes the first time. */
export function useConfigureAgent() {
  const configure = useRpc(configureAgentRpc);
  const awaitOperation = useAwaitOperation();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async (input: { agent: AgentId; update: boolean }) => awaitOperation(await configure(input)),
    onSettled: invalidate,
  });
}

export function useSandboxAction() {
  const act = useRpc(sandboxActionRpc);
  const awaitOperation = useAwaitOperation();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async (input: { name: string; action: "stop" | "remove" | "recreate" }) => {
      const result = await awaitOperation(await act(input));
      return input.action === "stop" ? stopResultSchema.parse(result) : null;
    },
    onSettled: invalidate,
  });
}

interface Shell {
  name: string;
  command: string;
  args: string[];
}

/** Opens a sandbox shell as a Paseo terminal of the workspace. */
export function useOpenTerminal(workspaceId: string) {
  const paseo = usePaseo();
  return (shell: Shell) =>
    paseo.terminals.create({ workspaceId, name: `sbx ${shell.name}`, command: shell.command, args: shell.args });
}

export function useArchiveAgent() {
  const paseo = usePaseo();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (agentId: string) => paseo.agents.ref(agentId).archive(),
    onSettled: invalidate,
  });
}

export function useRemoveTemplate() {
  const remove = useRpc(removeTemplateRpc);
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: (ref: string) => remove({ ref }), onSettled: invalidate });
}

const EMPTY_REPO: RepoConfig = { template: "", mounts: [], envNames: [], autoPublish: [] };

/** Saves a change to one repo's settings, against the revision the screen read. */
export function useRepoSettings(repoKey: string | null) {
  const settings = useSettings(sandboxSettings);
  const invalidate = useInvalidateAll();
  const repo = settings.status === "ready" && repoKey ? (settings.values.repos[repoKey] ?? EMPTY_REPO) : null;
  async function save(patch: Partial<RepoConfig>) {
    if (settings.status !== "ready" || !repoKey) throw new Error("settings are not loaded");
    const repos = { ...settings.values.repos, [repoKey]: { ...(settings.values.repos[repoKey] ?? EMPTY_REPO), ...patch } };
    await settings.save({ ...settings.values, repos }, settings.revision);
    invalidate();
  }
  return { settings, repo, save };
}

export function useSaveTemplate() {
  const saveRpc = useRpc(saveTemplateRpc);
  const awaitOperation = useAwaitOperation();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async (input: { name: string; tag: string }) => refResultSchema.parse(await awaitOperation(await saveRpc(input))),
    onSettled: invalidate,
  });
}
