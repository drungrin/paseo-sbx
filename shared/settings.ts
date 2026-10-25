import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const ISOLATION_MODES = ["workspace", "directory"] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

/** Items of the host's Claude config dir exposed read-only inside every sandbox config dir. */
export const DEFAULT_CLAUDE_SHARED = [
  "settings.json",
  "CLAUDE.md",
  "skills",
  "agents",
  "commands",
  "rules",
];

const overrideSchema = z.object({
  memoryGiB: z.number().positive().optional(),
  mounts: z.array(z.string()).default([]),
  envNames: z.array(z.string()).default([]),
});
export type SandboxOverride = z.infer<typeof overrideSchema>;

export const sandboxSettingsSchema = z.object({
  /** Rewrites new `claude` agents to `claude-sbx`, except under `excludedPaths`. */
  routeClaudeAgents: z.boolean().default(false),
  isolation: z.enum(ISOLATION_MODES).default("workspace"),
  memoryPercent: z.number().min(1).max(90).default(10),
  memoryFloorGiB: z.number().min(1).default(2),
  /** 0 lets sbx use every host CPU. */
  cpus: z.number().int().min(0).default(0),
  /** Extra mounts for every sandbox: absolute or `~/` paths, `:ro` for read-only. */
  mounts: z.array(z.string()).default([]),
  claudeShared: z.array(z.string()).default(DEFAULT_CLAUDE_SHARED),
  /** dotenv-style file the forwarded variables are read from; empty uses the default path. */
  envFile: z.string().default(""),
  envNames: z.array(z.string()).default([]),
  networkAllow: z.array(z.string()).default(["**"]),
  /** Host loopback ports relayed into every sandbox, beyond the ones detected per launch. */
  forwardPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  excludedPaths: z.array(z.string()).default([]),
  /** Keyed by `sandboxKey()`. */
  overrides: z.record(z.string(), overrideSchema).default({}),
});
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

export const sandboxSettings = defineSettings({
  id: "sandboxes",
  scope: "host",
  version: 1,
  schema: sandboxSettingsSchema,
});
