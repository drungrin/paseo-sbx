import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginPaths } from "./paths";

type PaseoApi = PluginHandlerContext["paseo"];

// Paseo keeps fields it does not know (passthrough).
interface TerminalProfile {
  [field: string]: unknown;
  id: string;
  name: string;
  command: string;
  args?: string[];
  icon?: string;
}

export const TERMINAL_PROFILE_ID = "paseo-sbx-terminal";

// Paseo's default terminal profiles (0.13). A stored list replaces them, so adding a profile to a
// config that has none stores these too.
const DEFAULT_PROFILES: readonly TerminalProfile[] = [
  { id: "claude", name: "Claude Code", command: "claude", args: ["{{{prompt}}}"], icon: "claude" },
  { id: "codex", name: "Codex", command: "codex", args: ["{{{prompt}}}"], icon: "codex" },
  { id: "opencode", name: "OpenCode", command: "opencode", args: ["--prompt={{{prompt}}}"], icon: "opencode" },
  { id: "pi", name: "Pi", command: "pi", args: ["{{{prompt}}}"], icon: "pi" },
];

let ensured = false;

/**
 * Adds the Sandbox terminal to the workspace's terminal menu, once: a profile you removed in
 * Settings stays removed. A profile already there keeps its name and place and gets the current
 * launcher path. Runs on the first screen or dashboard request after the plugin starts.
 */
export async function ensureTerminalProfile(paseo: PaseoApi, paths: PluginPaths): Promise<void> {
  if (ensured) return;
  const { config } = await paseo.config.get();
  const stored: TerminalProfile[] | undefined = config.terminalProfiles;
  const existing = stored?.find((profile) => profile.id === TERMINAL_PROFILE_ID);
  const marker = join(paths.root, "terminal-profile.json");
  if (existing) {
    if (existing.command !== paths.shellLauncher || (existing.args?.length ?? 0) > 0) {
      const terminalProfiles = (stored ?? []).map((profile) =>
        profile.id === TERMINAL_PROFILE_ID ? { ...profile, command: paths.shellLauncher, args: [] } : profile,
      );
      await paseo.config.patch({ terminalProfiles });
    }
  } else if (!existsSync(marker)) {
    const profile = { id: TERMINAL_PROFILE_ID, name: "Sandbox terminal", command: paths.shellLauncher, args: [] };
    await paseo.config.patch({ terminalProfiles: [...(stored ?? DEFAULT_PROFILES), profile] });
  }
  mkdirSync(paths.root, { recursive: true });
  if (!existsSync(marker)) writeFileSync(marker, `${JSON.stringify({ addedAt: new Date().toISOString() })}\n`);
  ensured = true;
}

/** Forgets that it ran, for tests. */
export function resetTerminalProfileForTests(): void {
  ensured = false;
}
