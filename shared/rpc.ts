import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { MOUNT_SOURCES } from "./spec";

const operationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  /** Sandbox name the operation works on. */
  target: z.string(),
  status: z.enum(["running", "done", "failed"]),
  error: z.string().nullable(),
  result: z.json().nullable(),
  startedAt: z.number(),
});
/** A sandbox operation; slow ones return as running and are polled with `operation.get`. */
export type OperationView = z.infer<typeof operationSchema>;

export const getOperationRpc = defineRpc({
  name: "operation.get",
  input: z.object({ id: z.string() }),
  output: operationSchema.nullable(),
});

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
    hostCpus: z.number(),
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
    /** CPUs a sandbox created now gets; 0 is every host CPU. */
    cpus: z.number(),
    repoCpus: z.number().nullable(),
    /** Whether the sandbox has the memory, CPUs and Docker disk configured now; null when unknown. */
    resourcesApplied: z.boolean().nullable(),
    /** Resident memory of the running VM; null when stopped or unknown. */
    rssMiB: z.number().nullable(),
    workspace: z.string(),
    /** Configured mounts besides the workspace, as a sandbox created now gets them. */
    mounts: z.array(
      z.object({
        path: z.string(),
        readOnly: z.boolean(),
        source: z.enum(MOUNT_SOURCES),
        /** False when the path does not exist on the host: sbx skips it. */
        exists: z.boolean(),
        /** Whether the sandbox has it; null when it does not exist or predates the record. */
        applied: z.boolean().nullable(),
      }),
    ),
    /** Mounts the sandbox has that are no longer configured. */
    removedMounts: z.array(z.string()),
    /** Null when the workspace does not use GSD Path. */
    gsdPath: z
      .object({
        /** The plugin setting that mounts `~/.gsd-path` and the members. */
        enabled: z.boolean(),
        members: z.array(z.object({ name: z.string(), path: z.string(), available: z.boolean() })),
      })
      .nullable(),
    env: z.array(
      z.object({
        name: z.string(),
        /** "all" when the plugin settings forward it to every repository. */
        scope: z.enum(["all", "repo"]),
        present: z.boolean(),
        /** sbx keeps it for itself; never forwarded. */
        reserved: z.boolean(),
      }),
    ),
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
    /** Operations on this sandbox or the repo's preparation sandbox, running or recently finished. */
    operations: z.array(operationSchema),
    services: z.object({
      /** When the guest last reported its listening ports (epoch seconds); null before any report. */
      snapshotAt: z.number().nullable(),
      listeners: z.array(z.object({ port: z.number(), addresses: z.array(z.string()) })),
      publications: z.array(
        z.object({
          guestPort: z.number(),
          allInterfaces: z.boolean(),
          reserved: z.boolean(),
          auto: z.boolean(),
          /** The host port sbx publishes it on now; null when it is not published (stopped, or the port was taken). */
          hostPort: z.number().nullable(),
        }),
      ),
    }),
  }),
});

export const publishPortRpc = defineRpc({
  name: "ports.publish",
  input: z.object({
    name: z.string(),
    guestPort: z.number().int().min(1).max(65535),
    allInterfaces: z.boolean(),
    hostPort: z.number().int().min(1).max(65535).nullable(),
  }),
  output: operationSchema,
});

export const unpublishPortRpc = defineRpc({
  name: "ports.unpublish",
  input: z.object({ name: z.string(), guestPort: z.number().int().min(1).max(65535) }),
  output: operationSchema,
});

export const sandboxActionRpc = defineRpc({
  name: "sandbox.action",
  input: z.object({ name: z.string(), action: z.enum(["stop", "remove", "recreate"]) }),
  /** A stop's result is `{ graceful }`, false when it could not shut the VM's Docker down first. */
  output: operationSchema,
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

/** Result: the shell (`{ name, command, args }`). */
export const shellCommandRpc = defineRpc({
  name: "sandbox.shell",
  input: workspaceTargetSchema,
  output: operationSchema,
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

/** Result: `{ ref }`. */
export const saveTemplateRpc = defineRpc({
  name: "template.save",
  input: z.object({ name: z.string(), tag: z.string() }),
  output: operationSchema,
});

export const removeTemplateRpc = defineRpc({
  name: "template.remove",
  input: z.object({ ref: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

/** Creates (or reuses) the repo's preparation sandbox. Result: its shell plus `repoKey`. */
export const prepareTemplateRpc = defineRpc({
  name: "template.prepare",
  input: workspaceTargetSchema,
  output: operationSchema,
});

/** Saves the preparation sandbox as a template and removes it. Result: `{ ref }`. */
export const finishTemplateRpc = defineRpc({
  name: "template.finish",
  input: z.object({ name: z.string(), tag: z.string() }),
  output: operationSchema,
});

export const shellResultSchema = shellSchema;
export const refResultSchema = z.object({ ref: z.string() });
