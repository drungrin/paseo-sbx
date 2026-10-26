import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FORWARDER_SOURCE,
  GUEST_AGENT_SOURCE,
  HOME_LINKS_SOURCE,
  SUPERVISOR_SOURCE,
  WAIT_PORTS_SOURCE,
  WRAPPER_SOURCE,
  launcherSource,
} from "./wrapper-source";

export interface PluginPaths {
  root: string;
  /** `XDG_STATE_HOME` of the Paseo-only sbx instance: its own daemon, sandboxes and policies. */
  stateHome: string;
  stateDir: string;
  locksDir: string;
  /** Per-session env files handed to `sbx exec --env-file`. */
  runDir: string;
  binDir: string;
  /** Provider command: a shell launcher that runs the wrapper with the daemon's node. */
  launcher: string;
  wrapper: string;
  /** Per-agent sandbox bindings, so resume and history keep the sandbox they started in. */
  bindingsDir: string;
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
    runDir: join(root, "run"),
    binDir,
    launcher: join(binDir, "paseo-sbx-claude"),
    wrapper: join(binDir, "paseo-sbx-claude.cjs"),
    bindingsDir: join(root, "agents"),
    claudeConfigs: join(root, "claude"),
    defaultEnvFile: join(env.XDG_CONFIG_HOME || join(home, ".config"), "paseo-sbx", "env"),
    hostClaudeDir: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
  };
}

function binFiles(paths: PluginPaths) {
  return [
    // The daemon's own node runs the wrapper; it changes when the daemon is upgraded.
    { name: "paseo-sbx-claude", source: launcherSource(process.execPath, paths.wrapper), mode: 0o755 },
    { name: "paseo-sbx-claude.cjs", source: WRAPPER_SOURCE, mode: 0o644 },
    { name: "loopback-forward.py", source: FORWARDER_SOURCE, mode: 0o644 },
    { name: "wait-ports.py", source: WAIT_PORTS_SOURCE, mode: 0o644 },
    { name: "guest-supervisor.py", source: SUPERVISOR_SOURCE, mode: 0o644 },
    { name: "guest-agent.py", source: GUEST_AGENT_SOURCE, mode: 0o644 },
    { name: "home-links.sh", source: HOME_LINKS_SOURCE, mode: 0o644 },
  ];
}

/** Writes the launcher, the wrapper and its guest helpers, leaving unchanged files untouched. */
export function installBinFiles(paths: PluginPaths): void {
  mkdirSync(paths.binDir, { recursive: true });
  for (const file of binFiles(paths)) {
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
