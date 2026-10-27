import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { activeAgentsBySandbox } from "./agents";
import type { ServerDeps } from "./hooks";
import { newLockToken, withSandboxLock } from "./lock";
import type { PluginPaths } from "./paths";
import { assertImageDownloadsAllowed, assertSandboxName, prepareSandbox, removeSandboxLocked } from "./sbx";
import { buildSpec } from "./spec-builder";
import {
  currentProcess,
  liveLeases,
  readSandboxState,
  removeRecreatingMarker,
  writeRecreatingMarker,
  type RecreatingMarker,
} from "./state";
import { findTemplate, listTemplates } from "./templates";

type PaseoApi = PluginHandlerContext["paseo"];

/**
 * Why the sandbox cannot be recreated now. The plugin API can neither close nor reopen an
 * agent's runtime, and a resident agent can start a turn at any time without going through the
 * wrapper, so every bound agent must be archived and no session may be running.
 */
export async function recreateBlockers(paths: PluginPaths, paseo: PaseoApi, name: string): Promise<string[]> {
  const blockers = ((await activeAgentsBySandbox(paths, paseo)).get(name) ?? []).map(
    (agent) => `agent ${agent.title ?? agent.id} is not archived`,
  );
  const leases = liveLeases(paths, name);
  if (leases.length > 0) blockers.push(`${leases.length} session(s) still running in the sandbox`);
  return blockers;
}

/**
 * Removes the sandbox and creates it again with the current settings for its repo. The server
 * owns the whole operation: it marks it so new launches fail fast, holds the sandbox lock, and
 * runs the wrapper's ensure step with the lock token so the wrapper does not wait for it. The
 * Claude config dir and its transcripts stay.
 */
export async function recreateSandbox(deps: ServerDeps, paseo: PaseoApi, name: string): Promise<void> {
  const { paths } = deps;
  assertSandboxName(name);
  const state = readSandboxState(paths, name);
  if (!state?.workspace || !state.key || state.kind === "template-prep") {
    throw new Error(`${name} has no record of how it was created; remove it instead`);
  }
  const before = await recreateBlockers(paths, paseo, name);
  if (before.length > 0) throw new Error(`cannot recreate ${name}: ${before.join("; ")}`);

  const settings = await deps.readSettings();
  const { spec } = await buildSpec({
    settings,
    workspaceId: null,
    cwd: state.workspace,
    paths,
    binding: { key: state.key, name, claudeConfigDir: state.claudeConfigDir ?? join(paths.claudeConfigs, name) },
  });
  // Validate before destroying anything.
  // Before the sandbox is removed: creating it again would be refused.
  if (!spec.template) assertImageDownloadsAllowed(settings, `Recreating ${name} from sbx's image`);
  if (spec.template && !findTemplate(await listTemplates(paths), spec.template)) {
    throw new Error(`template ${spec.template} not found; pick another template for the repo`);
  }

  const token = newLockToken();
  const marker: RecreatingMarker = { ...currentProcess(), token, phase: "waiting" };
  writeRecreatingMarker(paths, name, marker);
  try {
    await withSandboxLock(paths, name, token, async () => {
      const blockers = await recreateBlockers(paths, paseo, name);
      if (blockers.length > 0) throw new Error(`cannot recreate ${name}: ${blockers.join("; ")}`);
      writeRecreatingMarker(paths, name, { ...marker, phase: "removing" });
      await removeSandboxLocked(paths, name, { keepPublications: true });
      writeRecreatingMarker(paths, name, { ...marker, phase: "creating" });
      await prepareSandbox(paths, spec, token);
    });
  } finally {
    removeRecreatingMarker(paths, name);
  }
}
