import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const providerStatusSchema = z.object({
  /** An entry exists under `agents.providers`. */
  configured: z.boolean(),
  /** The entry points at this plugin's current wrapper and node binary. */
  current: z.boolean(),
});

export const statusRpc = defineRpc({
  name: "status.get",
  input: z.object({}),
  output: z.object({
    sbx: z.object({
      installed: z.boolean(),
      version: z.string().nullable(),
      daemon: z.enum(["running", "stopped", "unavailable"]),
      error: z.string().nullable(),
    }),
    provider: providerStatusSchema,
    stateHome: z.string(),
    wrapperPath: z.string(),
    envFile: z.string(),
    hostMemoryMiB: z.number(),
    defaultMemoryMiB: z.number(),
  }),
});

export const ensureProviderRpc = defineRpc({
  name: "provider.ensure",
  input: z.object({}),
  output: providerStatusSchema,
});

const sandboxSummarySchema = z.object({
  name: z.string(),
  status: z.string(),
  workspaces: z.array(z.string()),
  memory: z.string().nullable(),
});
export type SandboxSummary = z.infer<typeof sandboxSummarySchema>;

export const listSandboxesRpc = defineRpc({
  name: "sandboxes.list",
  input: z.object({}),
  output: z.object({ sandboxes: z.array(sandboxSummarySchema) }),
});

const workspaceTargetSchema = z.object({
  workspaceId: z.string().nullable(),
  directory: z.string(),
});

export const describeSandboxRpc = defineRpc({
  name: "sandbox.describe",
  input: workspaceTargetSchema,
  output: z.object({
    key: z.string(),
    name: z.string(),
    status: z.string().nullable(),
    memoryMiB: z.number(),
    overrideMemoryGiB: z.number().nullable(),
    mounts: z.array(z.string()),
    env: z.array(z.object({ name: z.string(), present: z.boolean() })),
  }),
});

export const sandboxActionRpc = defineRpc({
  name: "sandbox.action",
  input: z.object({ name: z.string(), action: z.enum(["stop", "remove"]) }),
  output: z.object({ ok: z.literal(true) }),
});

export const shellCommandRpc = defineRpc({
  name: "sandbox.shell",
  input: workspaceTargetSchema,
  output: z.object({ name: z.string(), command: z.string(), args: z.array(z.string()) }),
});
