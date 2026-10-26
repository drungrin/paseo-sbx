import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  describeSandboxRpc,
  ensureProviderRpc,
  listSandboxesRpc,
  listTemplatesRpc,
  memoryRpc,
  removeTemplateRpc,
  sandboxActionRpc,
  saveTemplateRpc,
  statusRpc,
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

/** Mutations change sandboxes and provider state; refresh every view of them. */
export function useInvalidateAll() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries();
}

export function useEnsureProvider() {
  const ensure = useRpc(ensureProviderRpc);
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: () => ensure({}), onSettled: invalidate });
}

export function useSandboxAction() {
  const act = useRpc(sandboxActionRpc);
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: { name: string; action: "stop" | "remove" | "recreate" }) => act(input),
    onSettled: invalidate,
  });
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
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: { name: string; tag: string }) => saveRpc(input),
    onSettled: invalidate,
  });
}
