import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  describeSandboxRpc,
  ensureProviderRpc,
  listSandboxesRpc,
  sandboxActionRpc,
  statusRpc,
} from "../shared/rpc";

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
    mutationFn: (input: { name: string; action: "stop" | "remove" }) => act(input),
    onSettled: invalidate,
  });
}
