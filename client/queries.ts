import type { AgentId } from "../shared/agents";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  addMcpServerRpc,
  cancelMcpSignInRpc,
  describeSandboxRpc,
  configureAgentRpc,
  finishMcpSignInRpc,
  getMcpSignInRpc,
  getOperationRpc,
  listMcpServersRpc,
  listSandboxesRpc,
  listTemplatesRpc,
  memoryRpc,
  removeMcpServerRpc,
  removeTemplateRpc,
  sandboxActionRpc,
  saveTemplateRpc,
  refResultSchema,
  startMcpSignInRpc,
  statusRpc,
  type OperationView,
  type SignInView,
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
  title: string;
  command: string;
  args: string[];
}

/** Opens a sandbox shell as a Paseo terminal of the workspace. */
export function useOpenTerminal(workspaceId: string) {
  const paseo = usePaseo();
  return (shell: Shell) => paseo.terminals.create({ workspaceId, name: shell.title, command: shell.command, args: shell.args });
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

export function useMcpServers() {
  const list = useRpc(listMcpServersRpc);
  return useQuery({ queryKey: ["mcp"], queryFn: () => list({}), refetchInterval: 15_000 });
}

/**
 * Saves MCP choices: for every sandbox (`setGlobal`), or for one repository (`setRepo`, null
 * follows the global choice). The plugin applies them to the sandboxes in the background; the
 * views refresh now and once it has had a moment.
 */
export function useMcpChoices() {
  const settings = useSettings(sandboxSettings);
  const queryClient = useQueryClient();
  function refresh() {
    void queryClient.invalidateQueries();
    setTimeout(() => void queryClient.invalidateQueries(), 2500);
  }
  async function setGlobal(name: string, on: boolean) {
    if (settings.status !== "ready") throw new Error("settings are not loaded");
    const others = settings.values.mcpGlobal.filter((entry) => entry !== name);
    await settings.save({ ...settings.values, mcpGlobal: on ? [...others, name].sort() : others }, settings.revision);
    refresh();
  }
  async function setRepo(repoKey: string, name: string, on: boolean | null) {
    if (settings.status !== "ready") throw new Error("settings are not loaded");
    const repo = settings.values.repos[repoKey] ?? EMPTY_REPO;
    const mcp = { ...repo.mcp };
    if (on === null) delete mcp[name];
    else mcp[name] = on;
    const repos = { ...settings.values.repos, [repoKey]: { ...repo, mcp } };
    await settings.save({ ...settings.values, repos }, settings.revision);
    refresh();
  }
  /** Drops every choice naming a removed server. */
  async function forget(name: string) {
    if (settings.status !== "ready") throw new Error("settings are not loaded");
    const repos = Object.fromEntries(
      Object.entries(settings.values.repos).map(([key, repo]) => {
        if (!repo.mcp || !(name in repo.mcp)) return [key, repo];
        const mcp = { ...repo.mcp };
        delete mcp[name];
        return [key, { ...repo, mcp }];
      }),
    );
    const mcpGlobal = settings.values.mcpGlobal.filter((entry) => entry !== name);
    await settings.save({ ...settings.values, mcpGlobal, repos }, settings.revision);
    refresh();
  }
  return { settings, setGlobal, setRepo, forget };
}

export function useAddMcpServer() {
  const add = useRpc(addMcpServerRpc);
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: add, onSettled: invalidate });
}

export function useRemoveMcpServer() {
  const remove = useRpc(removeMcpServerRpc);
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: (name: string) => remove({ name }), onSettled: invalidate });
}

/**
 * One OAuth sign-in at a time: `start` opens it, the view polls it while it waits (a browser on
 * the host finishes it without a paste), `finish` hands over the pasted address.
 */
export function useMcpSignIn() {
  const startRpc = useRpc(startMcpSignInRpc);
  const getRpc = useRpc(getMcpSignInRpc);
  const finishRpc = useRpc(finishMcpSignInRpc);
  const cancelRpc = useRpc(cancelMcpSignInRpc);
  const invalidate = useInvalidateAll();
  const [current, setCurrent] = useState<SignInView | null>(null);
  const settled = (next: SignInView) => {
    setCurrent(next);
    if (next.status !== "waiting") invalidate();
  };
  const polled = useQuery({
    queryKey: ["mcp-sign-in", current?.id],
    queryFn: () => getRpc({ id: current?.id ?? "" }),
    enabled: current?.status === "waiting",
    refetchInterval: 2000,
  });
  useEffect(() => {
    if (polled.data === undefined || !current || current.status !== "waiting") return;
    if (polled.data === null)
      setCurrent({ ...current, status: "failed", error: "The plugin restarted: start the sign-in again" });
    else if (polled.data.id === current.id && polled.data.status !== "waiting") settled(polled.data);
    // Only a new poll result moves it on.
  }, [polled.data]);
  const start = useMutation({ mutationFn: (server: string) => startRpc({ server }), onSuccess: settled });
  const finish = useMutation({
    mutationFn: (callbackUrl: string) => finishRpc({ id: current?.id ?? "", callbackUrl }),
    onSuccess: settled,
  });
  return {
    view: current,
    start,
    finish,
    close() {
      if (current?.status === "waiting") void cancelRpc({ id: current.id });
      setCurrent(null);
      start.reset();
      finish.reset();
    },
  };
}
