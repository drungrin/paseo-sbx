import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxBinding } from "../shared/spec";
import type { PluginPaths } from "./paths";

function bindingPath(paths: PluginPaths, agentId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error(`unexpected agent id: ${agentId}`);
  return join(paths.bindingsDir, `${agentId}.json`);
}

export function readBinding(paths: PluginPaths, agentId: string): SandboxBinding | null {
  try {
    const value = JSON.parse(readFileSync(bindingPath(paths, agentId), "utf8")) as Partial<SandboxBinding>;
    if (typeof value.key === "string" && typeof value.name === "string" && typeof value.claudeConfigDir === "string") {
      return { key: value.key, name: value.name, claudeConfigDir: value.claudeConfigDir };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeBinding(paths: PluginPaths, agentId: string, binding: SandboxBinding): void {
  mkdirSync(paths.bindingsDir, { recursive: true });
  writeFileSync(bindingPath(paths, agentId), `${JSON.stringify(binding, null, 2)}\n`);
}
