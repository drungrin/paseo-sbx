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
  kind: z.enum(["working", "template-prep"]),
  repoKey: z.string().nullable(),
  template: z.string().nullable(),
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

const boundAgentSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  activeTurn: z.boolean(),
  archived: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type BoundAgentInfo = z.infer<typeof boundAgentSchema>;

export const TEMPLATE_STATUSES = ["none", "match", "diverged", "unknown"] as const;

export const describeSandboxRpc = defineRpc({
  name: "sandbox.describe",
  input: workspaceTargetSchema,
  output: z.object({
    key: z.string(),
    name: z.string(),
    status: z.string().nullable(),
    repoKey: z.string(),
    repoName: z.string(),
    memoryMiB: z.number(),
    repoMemoryGiB: z.number().nullable(),
    /** Resident memory of the running VM; null when stopped or unknown. */
    rssMiB: z.number().nullable(),
    mounts: z.array(z.string()),
    env: z.array(z.object({ name: z.string(), present: z.boolean() })),
    template: z.object({
      /** What the repo's settings select now; null is sbx's image for Claude. */
      configured: z.string().nullable(),
      /** What the sandbox was created from; null is sbx's image, undefined state is "unknown". */
      sandbox: z.string().nullable(),
      status: z.enum(TEMPLATE_STATUSES),
    }),
    agents: z.array(boundAgentSchema),
    /** Why Recreate is unavailable; empty when it can run. */
    recreateBlockers: z.array(z.string()),
    /** The repo's template preparation sandbox, when one exists. */
    templatePrep: z.string().nullable(),
    /** Other sandboxes created for the same repo (other worktrees, older isolation modes). */
    siblings: z.array(z.string()),
  }),
});

export const sandboxActionRpc = defineRpc({
  name: "sandbox.action",
  input: z.object({ name: z.string(), action: z.enum(["stop", "remove", "recreate"]) }),
  /** `graceful` is false when a stop could not shut the VM's Docker down first. */
  output: z.object({ ok: z.literal(true), graceful: z.boolean().optional() }),
});

export const memoryRpc = defineRpc({
  name: "memory.get",
  input: z.object({}),
  output: z.object({
    host: z
      .object({
        totalMiB: z.number(),
        availableMiB: z.number(),
        swapUsedMiB: z.number(),
        psiSome60: z.number().nullable(),
      })
      .nullable(),
    /** Sum of the VMs' resident memory: an estimate, shared pages count once per VM. */
    vmRssMiB: z.number(),
    sandboxes: z.array(
      z.object({ name: z.string(), rssMiB: z.number().nullable(), activeAgents: z.array(boundAgentSchema) }),
    ),
    alerts: z.array(z.string()),
  }),
});

const shellSchema = z.object({ name: z.string(), command: z.string(), args: z.array(z.string()) });

export const shellCommandRpc = defineRpc({
  name: "sandbox.shell",
  input: workspaceTargetSchema,
  output: shellSchema,
});

const templateSchema = z.object({
  ref: z.string(),
  id: z.string(),
  createdAt: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  base: z.boolean(),
  /** "default" and repo keys whose settings select it. */
  users: z.array(z.string()),
});
export type TemplateSummary = z.infer<typeof templateSchema>;

export const listTemplatesRpc = defineRpc({
  name: "templates.list",
  input: z.object({}),
  output: z.object({ templates: z.array(templateSchema) }),
});

export const saveTemplateRpc = defineRpc({
  name: "template.save",
  input: z.object({ name: z.string(), tag: z.string() }),
  output: z.object({ ref: z.string() }),
});

export const removeTemplateRpc = defineRpc({
  name: "template.remove",
  input: z.object({ ref: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

/** Creates (or reuses) the repo's preparation sandbox and returns a shell into it. */
export const prepareTemplateRpc = defineRpc({
  name: "template.prepare",
  input: workspaceTargetSchema,
  output: shellSchema.extend({ repoKey: z.string() }),
});

/** Saves the preparation sandbox as a template and removes it. */
export const finishTemplateRpc = defineRpc({
  name: "template.finish",
  input: z.object({ name: z.string(), tag: z.string() }),
  output: z.object({ ref: z.string() }),
});
