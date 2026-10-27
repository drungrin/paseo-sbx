/** Agents the plugin runs in sandboxes: those sbx ships a kit for and Paseo has a provider for. */
export const AGENT_IDS = ["claude", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentDescriptor {
  id: AgentId;
  /** Provider the plugin registers in Paseo's config. */
  providerId: string;
  /** Paseo's built-in provider it extends. */
  extends: string;
  label: string;
  description: string;
  /** sbx built-in agent whose kit the catalog sandbox comes from. */
  kit: string;
  /** CLI the sessions run, found on the guest's PATH (the template's). */
  binary: string;
  /** sbx service secret its proxy signs in with. */
  secretService: string;
  /** How to add the CLI to a template that lacks it. */
  install: string;
  /**
   * The agent's home, shared by every sandbox and the catalog under the plugin's `homes/` dir and
   * named by this variable. Operations Paseo runs without a session (archive, unarchive, history)
   * then find the agent's threads from any VM. `kitHome` is where the kit keeps it under the
   * guest's home. Null keeps the agent's state per sandbox.
   */
  sharedHome: { env: string; dir: string; kitHome: string } | null;
  /**
   * Files the kit writes in its home that the shared home takes over: how the agent signs in
   * through the proxy (`replace`: refreshed at every catalog update) and its defaults (kept once
   * there, so you can edit them).
   */
  kitFiles: { path: string; replace: boolean }[];
}

export const AGENTS: Record<AgentId, AgentDescriptor> = {
  claude: {
    id: "claude",
    providerId: "claude-sbx",
    extends: "claude",
    label: "Claude (sandbox)",
    description: "Claude Code running in this workspace's Docker Sandboxes microVM",
    kit: "claude",
    binary: "claude",
    secretService: "anthropic",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    sharedHome: null,
    kitFiles: [],
  },
  codex: {
    id: "codex",
    providerId: "codex-sbx",
    extends: "codex",
    label: "Codex (sandbox)",
    description: "Codex running in this workspace's Docker Sandboxes microVM",
    kit: "codex",
    binary: "codex",
    secretService: "openai",
    install: "npm install -g @openai/codex",
    sharedHome: { env: "CODEX_HOME", dir: "codex", kitHome: ".codex" },
    kitFiles: [
      { path: "auth.json", replace: true },
      { path: "config.toml", replace: false },
    ],
  },
};

export function agentByProvider(providerId: string): AgentDescriptor | undefined {
  return Object.values(AGENTS).find((agent) => agent.providerId === providerId);
}

/** sbx's built-in agents, whose kits build sandboxes and name templates' flavors. */
export const SBX_AGENTS = ["claude", "codex", "copilot", "cursor", "devin", "docker-agent", "droid", "gemini", "kiro", "opencode", "shell"];

/** The kit a template was built with, from its flavor (`claude-code-docker` → `claude`). */
export function kitForFlavor(flavor: string | null | undefined): string | null {
  const matches = SBX_AGENTS.filter((agent) => (flavor ?? "").startsWith(agent));
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}
