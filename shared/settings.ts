import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { AGENT_IDS } from "./agents";

export const ISOLATION_MODES = ["workspace", "directory"] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

/**
 * Items of the host's Claude config dir each sandbox gets: folders linked read-only, files copied
 * at every session. `settings.json` is not one of them: each sandbox keeps its own, started from
 * sbx's kit, and gets only the `env` of yours (your login) at every session.
 */
export const DEFAULT_CLAUDE_SHARED = ["CLAUDE.md", "skills", "agents", "commands", "rules"];

/** The default before version 3, which shared `settings.json` too. */
export const LEGACY_CLAUDE_SHARED = ["settings.json", ...DEFAULT_CLAUDE_SHARED];

/** Per-repository settings, keyed by `repoKey()`: every worktree of a repo shares them. */
const repoConfigSchema = z.object({
  /** sbx template for new sandboxes of the repo; empty uses the global default. */
  template: z.string().default(""),
  memoryGiB: z.number().min(0.5).optional(),
  /** 0 lets sbx use every host CPU; unset uses the global value. */
  cpus: z.number().int().min(0).optional(),
  mounts: z.array(z.string()).default([]),
  envNames: z.array(z.string()).default([]),
  /** Guest ports published on ephemeral host ports whenever a sandbox of the repo is prepared. */
  autoPublish: z.array(z.number().int().min(1).max(65535)).default([]),
  /** MCP servers this repo's sandboxes load (true) or skip (false), over `mcpGlobal`. */
  mcp: z.record(z.string(), z.boolean()).optional(),
});
export type RepoConfig = z.infer<typeof repoConfigSchema>;

/** A version 1 per-sandbox override the migration could not attach to a single repo. */
const legacyOverrideSchema = z.object({
  memoryGiB: z.number().positive().optional(),
  mounts: z.array(z.string()).default([]),
  envNames: z.array(z.string()).default([]),
  reason: z.enum(["workspace", "conflict", "unresolved"]),
});
export type LegacyOverride = z.infer<typeof legacyOverrideSchema>;

const memoryAlertSchema = z.object({
  /** Alert when the host's memory PSI `some avg60` reaches this percentage. */
  psiPercent: z.number().min(1).max(100).default(10),
  /** Alert when available RAM falls below this percentage of the host's. */
  availablePercent: z.number().min(1).max(90).default(15),
});

export const sandboxSettingsSchema = z.object({
  /** Agents whose sandboxed provider the plugin registers; a turned-off one is kept, disabled. */
  enabledAgents: z.array(z.enum(AGENT_IDS)).default(["claude"]),
  /** Rewrites new `claude` agents to `claude-sbx`, except under `excludedPaths`. */
  routeClaudeAgents: z.boolean().default(false),
  /**
   * Your consent to download sbx's agent kit images from Docker Hub. Without it, nothing creates
   * a sandbox that could download one: catalogs, and sandboxes or template preparations without
   * a template. Sandboxes created from a template use the local image only.
   */
  allowImageDownloads: z.boolean().default(false),
  isolation: z.enum(ISOLATION_MODES).default("workspace"),
  memoryPercent: z.number().min(1).max(90).default(10),
  memoryFloorGiB: z.number().min(1).default(2),
  /** 0 lets sbx use every host CPU. */
  cpus: z.number().int().min(0).default(0),
  /** Size of each sandbox's `/var/lib/docker` volume, sparse on the host; 0 uses sbx's (10 GB). */
  dockerDiskGiB: z.number().int().min(0).default(0),
  /** Default sbx template for new sandboxes; empty uses sbx's image for Claude. */
  template: z.string().default(""),
  /** Extra mounts for every sandbox: absolute or `~/` paths, `:ro` for read-only. */
  mounts: z.array(z.string()).default([]),
  claudeShared: z.array(z.string()).default(DEFAULT_CLAUDE_SHARED),
  /**
   * dotenv-style file the forwarded variables are read from (`export NAME=value` works, so a shell
   * env file can serve); empty uses the default path. `~/` is your home.
   */
  envFile: z.string().default(""),
  envNames: z.array(z.string()).default([]),
  /**
   * Rewrites GitHub SSH remotes to HTTPS inside sandboxes, where the sbx proxy signs in with the
   * `github` secret (`sbx secret set github`). A guest has no SSH keys.
   */
  githubHttps: z.boolean().default(true),
  networkAllow: z.array(z.string()).default(["**"]),
  /** Host loopback ports relayed into every sandbox, beyond the ones detected per launch. */
  forwardPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  excludedPaths: z.array(z.string()).default([]),
  /**
   * For repositories that use GSD Path: mount `~/.gsd-path` (its runtime and worktrees) and the
   * member checkouts listed in `.project/MEMBERS.md`, writable.
   */
  gsdPath: z.boolean().default(true),
  /**
   * MCP servers registered in the Paseo sbx instance that every sandbox loads into its gateway,
   * existing and new ones, unless its repository turns them off.
   */
  mcpGlobal: z.array(z.string()).default([]),
  repos: z.record(z.string(), repoConfigSchema).default({}),
  /** Keyed by the version 1 sandbox key; shown in the Docker Sandboxes screen until resolved. */
  legacyOverrides: z.record(z.string(), legacyOverrideSchema).default({}),
  memoryAlert: memoryAlertSchema.default({ psiPercent: 10, availablePercent: 15 }),
});
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

export const SETTINGS_VERSION = 3;

/** Shared by both runtimes. The server registers it with its migration (`server/settings-migration.ts`). */
export const sandboxSettings = defineSettings({
  id: "sandboxes",
  scope: "host",
  version: SETTINGS_VERSION,
  schema: sandboxSettingsSchema,
});
