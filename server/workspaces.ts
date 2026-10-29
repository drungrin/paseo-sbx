import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxSpec } from "../shared/spec";
import type { PluginPaths } from "./paths";

const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Records the spec just built for a workspace, for the Sandbox terminal: its launcher has no way
 * to ask the plugin, so it reads `workspaces/<id>.json`. The forwarded variables stay out: a shell
 * gets none, and the file would hold their values.
 */
export function rememberWorkspaceSandbox(paths: PluginPaths, workspaceId: string | null, spec: SandboxSpec): void {
  if (!workspaceId || !WORKSPACE_ID.test(workspaceId)) return;
  mkdirSync(paths.workspacesDir, { recursive: true });
  writeFileSync(join(paths.workspacesDir, `${workspaceId}.json`), `${JSON.stringify({ ...spec, env: {} }, null, 2)}\n`);
}
