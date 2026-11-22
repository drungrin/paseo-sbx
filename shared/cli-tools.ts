import type { AgentId } from "./agents";
import type { SandboxSettings } from "./settings";

/**
 * Additional CLIs: agent CLIs a sandbox gets besides the agent of its session, installed,
 * updated and signed in by the plugin. Each one is described here and nowhere else: how to
 * download and check it, where it keeps its state and its credential, and how to sign in. There
 * is no free-form command: a CLI the plugin does not describe is not offered.
 */
export const CLI_IDS = ["claude", "codex", "muse", "agy"] as const;
export type CliId = (typeof CLI_IDS)[number];

/**
 * Where a repository's additional CLIs keep their credential. The state (settings, plugins,
 * skills, history) is always the sandbox's own; only the credential is shared in `global`.
 */
export const CLI_SCOPES = ["global", "sandbox"] as const;
export type CliScope = (typeof CLI_SCOPES)[number];

/** Node's names for the architectures a CLI can have a build for. The VMs run on the host's. */
export type CliArch = "x64" | "arm64";

export interface CliDigest {
  algorithm: "sha256" | "sha512";
  hex: string;
}

export interface CliArtifact {
  url: string;
  digest: CliDigest;
  /** A tarball's folder that holds the CLI, extracted without the folders above it. */
  root?: string;
}

export interface CliRelease {
  version: string;
  artifacts: Partial<Record<CliArch, CliArtifact>>;
}

/** A folder of the CLI's state in the guest's home, kept per sandbox. */
export interface CliStateDir {
  /** Under the guest's home: the CLI finds its state there. */
  home: string;
  /** Its folder in the sandbox's state for the CLI. */
  key: string;
}

/** How the CLI signs in: a file it writes in its state, or a token the shim passes it. */
export type CliCredential =
  | { kind: "file"; state: string; path: string }
  | { kind: "token"; env: string; file: string };

export interface CliDescriptor {
  id: CliId;
  label: string;
  vendor: string;
  /** The plugin's agent this CLI is: never additional in a sandbox of that agent's kit or session. */
  agent: AgentId | null;
  /** The version this plugin release installs, qualified in a sandbox. */
  pinned: CliRelease;
  /** How the download becomes the CLI: the file itself, or a tarball. */
  package: { kind: "binary" } | { kind: "tar"; exclude: string[] };
  /** The executable, relative to the version's folder. */
  entry: string;
  /** For a tarball: the member that becomes `entry` when its name differs. */
  member?: string;
  state: CliStateDir[];
  credential: CliCredential;
  /** Set by the shim before the CLI starts; `$HOME` expands in the guest. */
  env: Record<string, string>;
  /** Inherited variables the shim drops, so the CLI signs in with its own credential. */
  unsetEnv: string[];
  /** What you run in the Sandbox terminal to sign in. */
  login: string;
  /** A command that succeeds only when the CLI is signed in. */
  probe: string[];
  /** Hosts the CLI reaches, for a network policy that is not `**`. */
  hosts: string[];
  /** Hosts its downloads come from; anything else, redirects included, is refused. */
  downloadHosts: string[];
}

export const CLI_TOOLS: Record<CliId, CliDescriptor> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    vendor: "Anthropic",
    agent: "claude",
    pinned: {
      version: "2.1.330",
      artifacts: {
        x64: {
          url: "https://downloads.claude.ai/claude-code-releases/2.1.330/linux-x64/claude",
          digest: { algorithm: "sha256", hex: "f390eaa0814e6a1bff74cbb47acb74cb9c89d30ced809fe0af5af00c7bfe8ebb" },
        },
      },
    },
    package: { kind: "binary" },
    entry: "claude",
    state: [{ home: ".claude", key: "claude" }],
    // Claude renews its sign-in by renaming a new file over the old one, which a shared file
    // cannot follow: it signs in with a long-lived token (`claude setup-token`) instead.
    credential: { kind: "token", env: "CLAUDE_CODE_OAUTH_TOKEN", file: "oauth-token" },
    env: { CLAUDE_CONFIG_DIR: "$HOME/.claude", DISABLE_AUTOUPDATER: "1" },
    unsetEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"],
    login: "claude setup-token",
    probe: ["claude", "auth", "status"],
    hosts: ["api.anthropic.com", "platform.claude.com", "mcp-proxy.anthropic.com", "claude.ai"],
    downloadHosts: ["downloads.claude.ai"],
  },
  codex: {
    id: "codex",
    label: "Codex",
    vendor: "OpenAI",
    agent: "codex",
    pinned: {
      version: "0.166.0",
      artifacts: {
        x64: {
          url: "https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-linux-x64.tgz",
          digest: {
            algorithm: "sha512",
            hex: "0b10e6dfe0f57296c625e1eb77320da06fb7c27f4156770fe2aa5969a3589317bc88fb5124e6320899e73e8563591201bc8f6f3ca6d1a227ec312039c43694a7",
          },
          root: "package/vendor/x86_64-unknown-linux-musl",
        },
      },
    },
    // The native build: no Node, with its own bwrap and rg. Voice support is left out.
    package: { kind: "tar", exclude: ["codex-resources/voice"] },
    entry: "bin/codex",
    state: [{ home: ".codex", key: "codex" }],
    credential: { kind: "file", state: "codex", path: "auth.json" },
    // The Sandbox terminal points CODEX_HOME at the Codex agent's home: the additional one keeps its own.
    env: { CODEX_HOME: "$HOME/.codex" },
    unsetEnv: [],
    login: "codex login --device-auth",
    probe: ["codex", "login", "status"],
    hosts: ["chatgpt.com", "ab.chatgpt.com", "auth.openai.com", "*.oaiusercontent.com"],
    downloadHosts: ["registry.npmjs.org"],
  },
  muse: {
    id: "muse",
    label: "Muse Code",
    vendor: "Meta",
    agent: null,
    pinned: {
      version: "1.4.25-R9361.1",
      artifacts: {
        x64: {
          url: "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.25-R9361.1&file=muse-x86-linux",
          digest: { algorithm: "sha256", hex: "c1b728fb9732503c5e1869e3ad2f2c9bdb5b2638fb4cf398d6e2c46aa6d8f94a" },
        },
      },
    },
    // The binary itself, without Meta's launcher, which would update it.
    package: { kind: "binary" },
    entry: "muse",
    state: [
      { home: ".config/muse", key: "config" },
      { home: ".local/share/muse", key: "data" },
    ],
    credential: { kind: "file", state: "config", path: "auth.json" },
    env: { MUSE_NO_AUTO_UPDATE: "1" },
    unsetEnv: [],
    login: "muse login",
    probe: ["muse", "usage", "--json"],
    hosts: ["api.meta.ai", "auth.meta.com"],
    downloadHosts: ["api.meta.ai", "lookaside.facebook.com"],
  },
  agy: {
    id: "agy",
    label: "Antigravity",
    vendor: "Google",
    agent: null,
    pinned: {
      version: "1.5.14",
      artifacts: {
        x64: {
          url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-x64/cli_linux_x64.tar.gz",
          digest: {
            algorithm: "sha512",
            hex: "83311d3f354567612dc16c1ae2ea9b503d6f6833aa4e138d39aa229da3f3bb99b0e4d7cca0bce4796b0060d6a51d8113eb7449ed5dc0e7900bf217107ea5bff9",
          },
        },
      },
    },
    package: { kind: "tar", exclude: [] },
    entry: "agy",
    member: "antigravity",
    state: [{ home: ".gemini", key: "gemini" }],
    credential: { kind: "file", state: "gemini", path: "antigravity-cli/antigravity-oauth-token" },
    env: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
    unsetEnv: [],
    login: "agy",
    probe: ["agy", "models"],
    hosts: [
      "aicode.googleapis.com",
      "daily-cloudcode-pa.googleapis.com",
      "oauth2.googleapis.com",
      "www.googleapis.com",
      "play.googleapis.com",
      "lh3.googleusercontent.com",
      "accounts.google.com",
    ],
    downloadHosts: ["antigravity-cli-auto-updater-974169037036.us-central1.run.app", "storage.googleapis.com"],
  },
};

/** Versions are folder names: a release that does not look like one is refused. */
export const CLI_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-R[0-9]+(?:\.[0-9]+)?)?$/;

/** The plugin's agent a sandbox kit runs (`kitForFlavor`), when it is one of the plugin's agents. */
function kitAgent(kit: string | null): AgentId | null {
  return kit === "claude" || kit === "codex" ? kit : null;
}

/**
 * Whether a CLI is additional for a session: never the agent of the sandbox's kit (a Claude
 * template never gets an additional `claude`), nor the agent of the session. The Sandbox
 * terminal has no session agent (null).
 */
export function cliAvailable(id: CliId, kit: string | null, sessionAgent: AgentId | null): boolean {
  const agent = CLI_TOOLS[id].agent;
  if (agent === null) return true;
  return agent !== kitAgent(kit) && agent !== sessionAgent;
}

type CliChoices = Pick<SandboxSettings, "cliTools" | "repos">;

/** Whether a repository's sandboxes get a CLI: the repository's choice, else the global list. */
export function cliEnabled(settings: CliChoices, repoKey: string, id: CliId): boolean {
  return settings.repos[repoKey]?.cliTools?.[id] ?? settings.cliTools.enabled.includes(id);
}

/** The CLIs a repository's sandboxes get, in catalog order. */
export function cliSelected(settings: CliChoices, repoKey: string): CliId[] {
  return CLI_IDS.filter((id) => cliEnabled(settings, repoKey, id));
}

/** Where a repository's CLIs keep their credential: its own choice, else the global one. */
export function cliScope(settings: CliChoices, repoKey: string): CliScope {
  return settings.repos[repoKey]?.cliScope ?? settings.cliTools.scope;
}

/** CLIs some repository or every one turned on: the ones the plugin keeps installed. */
export function cliWanted(settings: CliChoices): CliId[] {
  const wanted = new Set<CliId>(settings.cliTools.enabled);
  for (const repo of Object.values(settings.repos)) {
    for (const [id, on] of Object.entries(repo.cliTools ?? {})) {
      if (on && (CLI_IDS as readonly string[]).includes(id)) wanted.add(id as CliId);
    }
  }
  return CLI_IDS.filter((id) => wanted.has(id));
}

/** The manifest's version (`PASEO_SBX_CLI_MANIFEST`): consumers refuse another major one. */
export const CLI_MANIFEST_VERSION = 1;

/** Exit status and stderr prefix of a shim whose CLI state is not mounted. */
export const CLI_SHIM_UNMOUNTED_EXIT = 78;
export const CLI_SHIM_PREFIX = "paseo-sbx-cli: ";
