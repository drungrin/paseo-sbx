import type { SandboxSettings } from "./settings";

type KubeChoices = Pick<SandboxSettings, "kube" | "kubeContexts" | "repos">;

/** The kubeconfig the plugin writes for a sandbox, relative to its Claude config dir (mounted at the same path). */
export const KUBE_FILE = ".paseo-sbx/kubeconfig.json";

/**
 * The sandbox's own kubeconfig, first in the guest's `KUBECONFIG`: tools that write one (k3d,
 * `kubectl config use-context`) write it there, and its current context wins.
 */
export const GUEST_KUBECONFIG = "/home/agent/.kube/config";

/** Whether a repository's sandboxes get host contexts: its own choice, else the global one. */
export function kubeEnabled(settings: Pick<KubeChoices, "kube" | "repos">, repoKey: string): boolean {
  return settings.repos[repoKey]?.kube ?? settings.kube;
}

/** Whether a repository's sandboxes get a context: the repository's choice, else the global list. */
export function kubeContextOn(settings: KubeChoices, repoKey: string, name: string): boolean {
  return settings.repos[repoKey]?.kubeContexts?.[name] ?? settings.kubeContexts.includes(name);
}

/** The host contexts a repository's sandboxes get, sorted; none when the integration is off for it. */
export function kubeSelected(settings: KubeChoices, repoKey: string): string[] {
  if (!kubeEnabled(settings, repoKey)) return [];
  const names = new Set([...settings.kubeContexts, ...Object.keys(settings.repos[repoKey]?.kubeContexts ?? {})]);
  return [...names].filter((name) => kubeContextOn(settings, repoKey, name)).sort();
}
