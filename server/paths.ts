import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FORWARDER_SOURCE, WAIT_PORTS_SOURCE, WRAPPER_SOURCE } from "./wrapper-source";

export interface PluginPaths {
  root: string;
  /** `XDG_STATE_HOME` of the Paseo-only sbx instance: its own daemon, sandboxes and policies. */
  stateHome: string;
  stateDir: string;
  locksDir: string;
  binDir: string;
  wrapper: string;
  claudeConfigs: string;
  defaultEnvFile: string;
  hostClaudeDir: string;
}

export function pluginPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): PluginPaths {
  const root = join(env.XDG_STATE_HOME || join(home, ".local", "state"), "paseo-sbx");
  const binDir = join(root, "bin");
  return {
    root,
    stateHome: join(root, "sbx"),
    stateDir: join(root, "sandboxes"),
    locksDir: join(root, "locks"),
    binDir,
    wrapper: join(binDir, "paseo-sbx-claude.cjs"),
    claudeConfigs: join(root, "claude"),
    defaultEnvFile: join(env.XDG_CONFIG_HOME || join(home, ".config"), "paseo-sbx", "env"),
    hostClaudeDir: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
  };
}

const BIN_FILES = [
  { name: "paseo-sbx-claude.cjs", source: WRAPPER_SOURCE, mode: 0o755 },
  { name: "loopback-forward.py", source: FORWARDER_SOURCE, mode: 0o644 },
  { name: "wait-ports.py", source: WAIT_PORTS_SOURCE, mode: 0o644 },
];

/** Writes the wrapper and its guest helpers, leaving unchanged files untouched. */
export function installBinFiles(paths: PluginPaths): void {
  mkdirSync(paths.binDir, { recursive: true });
  for (const file of BIN_FILES) {
    const target = join(paths.binDir, file.name);
    let current: string | null = null;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = null;
    }
    if (current !== file.source) writeFileSync(target, file.source);
    chmodSync(target, file.mode);
  }
}
