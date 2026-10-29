import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { SandboxSettings } from "../shared/settings";
import type { SandboxSpec } from "../shared/spec";
import type { PluginPaths } from "./paths";
import { buildSpec, prepareClaudeConfigDir } from "./spec-builder";

type PaseoApi = PluginHandlerContext["paseo"];

const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

function recordPath(paths: PluginPaths, workspaceId: string): string {
  return join(paths.workspacesDir, `${workspaceId}.json`);
}

/**
 * Records the spec just built for a workspace, for the Sandbox terminal: its launcher has no way
 * to ask the plugin, so it reads `workspaces/<id>.json`. The forwarded variables stay out: a shell
 * gets none, and the file would hold their values.
 */
export function rememberWorkspaceSandbox(paths: PluginPaths, workspaceId: string | null, spec: SandboxSpec): void {
  if (!workspaceId || !WORKSPACE_ID.test(workspaceId)) return;
  mkdirSync(paths.workspacesDir, { recursive: true });
  writeFileSync(recordPath(paths, workspaceId), `${JSON.stringify({ ...spec, env: {} }, null, 2)}\n`);
}

/**
 * Records a workspace's sandbox as the settings make it now, as its dashboard would. A sandbox
 * already used gets its config dir brought up to date too: the terminal opened from the + menu
 * does not prepare it, and one from before shared files were copied still links your settings.
 */
export async function recordWorkspace(
  paths: PluginPaths,
  settings: SandboxSettings,
  workspaceId: string,
  directory: string,
): Promise<void> {
  if (!WORKSPACE_ID.test(workspaceId) || !existsSync(directory)) return;
  const { spec } = await buildSpec({ settings, workspaceId, cwd: directory, paths, prepare: false });
  if (existsSync(spec.claudeConfigDir)) prepareClaudeConfigDir(spec.claudeConfigDir, paths.hostClaudeDir, settings.claudeShared);
  rememberWorkspaceSandbox(paths, workspaceId, spec);
}

let backfill: Promise<void> | null = null;

/**
 * Workspaces from before the records existed have none until a session opens there or their
 * dashboard does, and the Sandbox terminal would close at once with nothing to read. The missing
 * ones are filled once per plugin process, from the first call that can reach Paseo.
 */
export function backfillWorkspaceRecords(
  paths: PluginPaths,
  readSettings: () => Promise<SandboxSettings>,
  paseo: PaseoApi,
): Promise<void> {
  backfill ??= (async () => {
    const settings = await readSettings();
    let cursor: string | undefined;
    for (;;) {
      const page = await paseo.workspaces.list({ page: cursor ? { limit: 200, cursor } : { limit: 200 } });
      for (const workspace of page.entries) {
        if (existsSync(recordPath(paths, workspace.id))) continue;
        const directory = workspace.workspaceDirectory ?? workspace.projectRootPath;
        try {
          await recordWorkspace(paths, settings, workspace.id, directory);
        } catch (error) {
          console.warn(`[paseo-sbx] recording ${workspace.id} for the Sandbox terminal: ${errorText(error)}`);
        }
      }
      if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) return;
      cursor = page.pageInfo.nextCursor;
    }
  })().catch((error) => {
    console.warn(`[paseo-sbx] recording workspaces for the Sandbox terminal: ${errorText(error)}`);
  });
  return backfill;
}

export function resetWorkspaceBackfillForTests(): void {
  backfill = null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
