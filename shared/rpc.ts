import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { AGENT_IDS } from "./agents";
import { CLI_IDS, CLI_SCOPES } from "./cli-tools";
import { MCP_HEADER_PATTERN, MCP_NAME_PATTERN } from "./mcp";
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
  /** The entry is enabled and points at this plugin's current launcher. */
  current: z.boolean(),
});

const agentStatusSchema = z.object({
  id: z.enum(AGENT_IDS),
  label: z.string(),
  providerId: z.string(),
  /** Turned on in the plugin settings. */
  enabled: z.boolean(),
  provider: providerStatusSchema,
  catalog: z.object({
    name: z.string(),
    exists: z.boolean(),
    /** The kit's CLI version, recorded when the catalog was created; null before. */
    cliVersion: z.string().nullable(),
    createdAt: z.string().nullable(),
  }),
  /** The sbx service secret it signs in with, and whether one applies. */
  login: z.object({
    service: z.string(),
    stored: z.boolean(),
    /**
     * Claude only: the login sessions get on their own, which wins over the secret. From your
     * Claude settings' env or the daemon's environment (variable names only); `helper` when your
     * settings sign in with an apiKeyHelper. Null for other agents.
     */
    own: z
      .object({
        source: z.enum(["settings", "environment", "unreadable"]).nullable(),
        names: z.array(z.string()),
        helper: z.boolean(),
      })
      .nullable()
      .default(null),
  }),
  /** How to add the CLI to a template. */
  install: z.string(),
});
export type AgentStatus = z.infer<typeof agentStatusSchema>;

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
    agents: z.array(agentStatusSchema),
    stateHome: z.string(),
    wrapperPath: z.string(),
    envFile: z.string(),
    hostMemoryMiB: z.number(),
    hostCpus: z.number(),
    defaultMemoryMiB: z.number(),
  }),
});

/** The plugin's Starship for the Sandbox terminal: the version in its folder, a download under way or failed. */
export const starshipStatusRpc = defineRpc({
  name: "starship.status",
  input: z.object({}),
  output: z.object({
    enabled: z.boolean(),
    version: z.string().nullable(),
    installing: z.boolean(),
    error: z.string().nullable(),
  }),
});

/** Registers the agent's provider and creates its catalog sandbox; `update` recreates it from a fresh kit. */
export const configureAgentRpc = defineRpc({
  name: "agent.configure",
  input: z.object({ agent: z.enum(AGENT_IDS), update: z.boolean() }),
  output: operationSchema,
});

const sandboxSummarySchema = z.object({
  name: z.string(),
  status: z.string(),
  workspaces: z.array(z.string()),
  memory: z.string().nullable(),
  kind: z.enum(["working", "template-prep", "catalog"]),
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
    /**
     * Each resource that differs, as sbx takes it: memory `8192m`, CPUs a count (`0` is every host
     * CPU), Docker disk `60g` (null is sbx's). Empty when they match or are unknown.
     */
    resourceChanges: z
      .array(
        z.object({
          resource: z.enum(["memory", "cpus", "dockerDisk"]),
          created: z.string().nullable(),
          configured: z.string().nullable(),
        }),
      )
      .default([]),
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
        /** The integration for this repo: its own choice, else the plugin setting. */
        enabled: z.boolean(),
        /** The plugin setting, which a repo without its own choice follows. */
        global: z.boolean(),
        /** The repo's own choice; null follows the plugin setting. */
        repoChoice: z.boolean().nullable(),
        members: z.array(z.object({ name: z.string(), path: z.string(), available: z.boolean() })),
        /** Whether GSD Path's config lists this sandbox's session folder. */
        sessions: z.enum(["listed", "not-listed", "no-config", "invalid-config"]),
        sessionsFolder: z.string(),
        configPath: z.string(),
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
    /** Host Kubernetes contexts the repository's sandboxes get, from the settings alone. */
    kube: z.object({ enabled: z.boolean(), contexts: z.array(z.string()) }),
    /** Additional CLIs the repository's sandboxes get, from the settings alone. */
    cli: z.object({ enabled: z.array(z.enum(CLI_IDS)) }),
    mcp: z.object({
      /** Servers the plugin loads into the repository's sandboxes. */
      autoLoad: z.array(z.string()),
      /** Servers the sandbox's gateway has loaded, by the plugin or an agent; null when unknown. */
      loaded: z.array(z.string()).nullable(),
      /** Why `loaded` is unknown when sbx's record of it could not be read; null otherwise. */
      unreadable: z.string().nullable(),
      /** Servers turned off while the sandbox was stopped: unloaded when it next starts. */
      pendingUnload: z.array(z.string()),
      /** Why loading or unloading a server failed, by server. */
      errors: z.record(z.string(), z.string()),
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

const fileUseSchema = z.object({ usedBytes: z.number(), sizeBytes: z.number() });

export const diskRpc = defineRpc({
  name: "disk.get",
  input: z.object({}),
  output: z.object({
    /** The filesystem holding the sandboxes; null when unreadable. */
    host: z.object({ path: z.string(), totalBytes: z.number(), availableBytes: z.number() }).nullable(),
    /** Sum of the sandboxes' `usedBytes`. */
    sandboxesBytes: z.number(),
    /** Image layers and templates, shared between sandboxes. */
    imagesBytes: z.number(),
    /**
     * Space each sandbox's files take on the host, biggest first; one with none found is left out.
     * The images are sparse: `usedBytes` is what the host spends, `sizeBytes` the disk the VM sees.
     */
    sandboxes: z.array(
      z.object({
        name: z.string(),
        usedBytes: z.number(),
        docker: fileUseSchema.nullable(),
        rootfs: fileUseSchema.nullable(),
        agentBytes: z.number(),
      }),
    ),
    alerts: z.array(z.string()),
  }),
});

/** `name` is the sandbox; `title` names the terminal tab. */
const shellSchema = z.object({ name: z.string(), title: z.string(), command: z.string(), args: z.array(z.string()) });

/**
 * The Sandbox terminal of a workspace: records the workspace's sandbox for the terminal's
 * launcher, which creates it when missing, and returns the command to open.
 */
export const sandboxTerminalRpc = defineRpc({
  name: "sandbox.terminal",
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
  /** Existing sandboxes created from it. Removing it needs both lists empty. */
  sandboxes: z.array(z.string()),
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

const mcpServerSchema = z.object({
  name: z.string(),
  url: z.string().nullable(),
  /** sbx's status: "ready", "needs-auth", "needs-secret", or one it adds later. */
  status: z.string(),
  detail: z.string().nullable(),
  /** The sbx command that fixes its status (`sbx secret set mcp:…`), when sbx names one. */
  nextStep: z.string().nullable(),
  /** How it signs in: OAuth through sbx, an API key in a header, or not at all. */
  auth: z.enum(["oauth", "api-key", "none"]),
  /** Sandboxes whose gateway has it loaded. */
  loadedIn: z.array(z.string()),
});
export type McpServerView = z.infer<typeof mcpServerSchema>;

/** The MCP servers registered in the Paseo sbx instance. */
export const listMcpServersRpc = defineRpc({
  name: "mcp.servers.list",
  input: z.object({}),
  output: z.object({
    servers: z.array(mcpServerSchema),
    /** Working sandboxes: the ones servers load into. */
    sandboxes: z.number(),
    /** What the plugin could not read from sbx (its format changed); null when it read everything. */
    unrecognized: z.string().nullable(),
  }),
});

/** Registers a remote server. Without an API key, one that uses OAuth then needs a sign-in. */
export const addMcpServerRpc = defineRpc({
  name: "mcp.servers.add",
  input: z.object({
    name: z.string().regex(MCP_NAME_PATTERN),
    url: z.string(),
    /** Sent in `header` on every request; the value goes to sbx's secret store only. */
    apiKey: z.object({ header: z.string().regex(MCP_HEADER_PATTERN), value: z.string().min(1) }).nullable(),
  }),
  output: mcpServerSchema,
});

/** Unloads the server from every sandbox, then removes it with its credentials. */
export const removeMcpServerRpc = defineRpc({
  name: "mcp.servers.remove",
  input: z.object({ name: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

const signInSchema = z.object({
  id: z.string(),
  server: z.string(),
  /** The provider's authorization page; null when sbx opened a browser on the host instead. */
  url: z.string().nullable(),
  /** Where the provider sends the browser back, on the Paseo host (`http://127.0.0.1:<port>`). */
  callbackOrigin: z.string().nullable(),
  status: z.enum(["waiting", "done", "failed", "cancelled"]),
  error: z.string().nullable(),
});
export type SignInView = z.infer<typeof signInSchema>;

/** Starts sbx's OAuth sign-in for a server and returns its authorization page. */
export const startMcpSignInRpc = defineRpc({
  name: "mcp.sign-in.start",
  input: z.object({ server: z.string() }),
  output: signInSchema,
});

/** Null once the plugin forgot it (it restarted, or the sign-in ended long ago). */
export const getMcpSignInRpc = defineRpc({
  name: "mcp.sign-in.get",
  input: z.object({ id: z.string() }),
  output: signInSchema.nullable(),
});

/** Hands sbx the address the provider sent the browser back to, for a browser off the host. */
export const finishMcpSignInRpc = defineRpc({
  name: "mcp.sign-in.finish",
  input: z.object({ id: z.string(), callbackUrl: z.string() }),
  output: signInSchema,
});

export const cancelMcpSignInRpc = defineRpc({
  name: "mcp.sign-in.cancel",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

const hostContextSchema = z.object({
  name: z.string(),
  cluster: z.string(),
  server: z.string().nullable(),
  /** Where sandboxes reach it: a cluster on this host at host.docker.internal, others unchanged. */
  guestServer: z.string().nullable(),
  /** The namespace the host kubeconfig gives it. */
  namespace: z.string().nullable(),
  auth: z.enum(["client-certificate", "token", "token-file", "basic", "exec", "auth-provider", "none"]),
  /** Why sandboxes cannot use it; null when they can. */
  unsupported: z.string().nullable(),
});
export type HostContextView = z.infer<typeof hostContextSchema>;

const hostKubeSchema = z.object({
  /** The kubeconfig read, as `KUBECONFIG` takes it. */
  file: z.string(),
  /** Why it could not be read; null when it was. */
  error: z.string().nullable(),
  /** The host's current context. */
  current: z.string().nullable(),
  contexts: z.array(hostContextSchema),
});

/** This host's Kubernetes contexts, for the plugin settings. */
export const kubeHostRpc = defineRpc({
  name: "kube.host",
  input: z.object({}),
  output: hostKubeSchema,
});

/** A repository's Kubernetes choices against this host's contexts, and what its sandbox has. */
export const kubeRepoRpc = defineRpc({
  name: "kube.repo",
  input: workspaceTargetSchema,
  output: z.object({
    host: hostKubeSchema,
    /** The integration for this repo: its own choice, else the plugin setting. */
    enabled: z.boolean(),
    global: z.boolean(),
    /** The repo's own choice; null follows the plugin setting. */
    repoChoice: z.boolean().nullable(),
    contexts: z.array(
      hostContextSchema.extend({
        /** The sandboxes get it: the repo's choice, else the plugin's list. */
        on: z.boolean(),
        /** The repo's own choice; null follows the plugin's list. */
        choice: z.boolean().nullable(),
        /** On the plugin's list for every repository. */
        global: z.boolean(),
        /** The repo's own namespace for it; null keeps the host's. */
        repoNamespace: z.string().nullable(),
      }),
    ),
    /** Chosen contexts this host's kubeconfig does not have. */
    missing: z.array(z.string()),
    /** Chosen contexts left out, with why. */
    skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
    /** The context sessions get by default, unless the sandbox's own kubeconfig sets one. */
    current: z.string().nullable(),
    repoCurrent: z.string().nullable(),
    /** The repo wants no default context: kubectl without --context fails. */
    noDefault: z.boolean(),
    sandbox: z.object({
      name: z.string(),
      /** sbx's status; null before the sandbox exists. */
      status: z.string().nullable(),
      /** The kubeconfig the plugin writes for it. */
      file: z.string(),
      /** What that file holds now; null before a session or the Sandbox terminal wrote it. */
      written: z.object({ contexts: z.array(z.string()), current: z.string().nullable(), writtenAt: z.number() }).nullable(),
    }),
  }),
});

/** Calls each of the plugin's contexts from inside the workspace's running sandbox. */
export const kubeTestRpc = defineRpc({
  name: "kube.test",
  input: workspaceTargetSchema,
  output: z.object({
    kubectl: z.string().nullable(),
    own: z.array(z.string()).nullable(),
    ownCurrent: z.string().nullable(),
    current: z.string().nullable(),
    results: z.array(z.object({ context: z.string(), ok: z.boolean(), detail: z.string() })),
    error: z.string().nullable(),
  }),
});

const cliIdSchema = z.enum(CLI_IDS);

const cliToolSchema = z.object({
  id: cliIdSchema,
  label: z.string(),
  vendor: z.string(),
  /** The version this plugin release installs. */
  pinned: z.string(),
  /** The version sandboxes run; null before one is installed. */
  active: z.string().nullable(),
  installedAt: z.number().nullable(),
  /** Every version in the plugin's folder, the active one included. */
  versions: z.array(z.string()),
  installing: z.boolean(),
  /** The version being installed. */
  target: z.string().nullable(),
  /** Why the last install failed; null when it did not. */
  error: z.string().nullable(),
  /** On for every repository (the plugin's list). */
  enabled: z.boolean(),
  /** Repositories that turn it on themselves. */
  repos: z.number(),
  /** What you run in a workspace's Sandbox terminal to sign in. */
  login: z.string(),
  /** How it signs in: a file it writes, or a token you paste (Claude). */
  credential: z.enum(["file", "token"]),
  /** A shared credential exists: present, not checked. */
  globalCredential: z.boolean(),
  /** Hosts it reaches, for a network policy that is not `**`. */
  hosts: z.array(z.string()),
});
export type CliToolView = z.infer<typeof cliToolSchema>;

/** The additional CLIs: versions in the plugin's folder, installs and shared credentials. */
export const cliToolsRpc = defineRpc({
  name: "cli.tools",
  input: z.object({}),
  output: z.object({
    /** This host's architecture, and whether the CLIs were qualified on it. */
    arch: z.string(),
    qualified: z.boolean(),
    /** Where credentials live unless a repository chooses: the plugin setting. */
    scope: z.enum(CLI_SCOPES),
    /** The network policy lets sandboxes reach every host. */
    networkOpen: z.boolean(),
    /** Some sandbox is running: removing versions waits until none is. */
    running: z.boolean(),
    tools: z.array(cliToolSchema),
  }),
});

/** Installs a CLI's pinned release or the vendor's current one, in the background. */
export const cliInstallRpc = defineRpc({
  name: "cli.install",
  input: z.object({ id: cliIdSchema, release: z.enum(["pinned", "latest"]) }),
  output: z.object({ ok: z.literal(true) }),
});

/** The vendor's current version of a CLI, read from its manifest; nothing is downloaded. */
export const cliLatestRpc = defineRpc({
  name: "cli.latest",
  input: z.object({ id: cliIdSchema }),
  output: z.object({ version: z.string() }),
});

/** Removes the versions no CLI uses, while no sandbox runs. */
export const cliRemoveUnusedRpc = defineRpc({
  name: "cli.remove-unused",
  input: z.object({}),
  output: z.object({ removed: z.array(z.string()) }),
});

/** A repository's additional CLIs and what its sandbox has of them. */
export const cliRepoRpc = defineRpc({
  name: "cli.repo",
  input: workspaceTargetSchema,
  output: z.object({
    /** Where the repository's credentials live: its own choice, else the plugin setting. */
    scope: z.enum(CLI_SCOPES),
    repoScope: z.enum(CLI_SCOPES).nullable(),
    globalScope: z.enum(CLI_SCOPES),
    /** The sbx kit of the sandbox; its own agent is never an additional CLI. */
    kit: z.string().nullable(),
    sandbox: z.object({ name: z.string(), status: z.string().nullable() }),
    /** The shared credentials folder: needed in the global scope; applied once the sandbox has it. */
    mount: z.object({ path: z.string(), needed: z.boolean(), applied: z.boolean().nullable() }),
    clis: z.array(
      z.object({
        id: cliIdSchema,
        label: z.string(),
        /** The repository's sandboxes get it: its choice, else the plugin's list. */
        enabled: z.boolean(),
        /** The repository's own choice; null follows the plugin's list. */
        choice: z.boolean().nullable(),
        global: z.boolean(),
        /** Why this sandbox cannot have it (its kit's own agent); null when it can. */
        unavailable: z.string().nullable(),
        active: z.string().nullable(),
        credential: z.enum(["file", "token"]),
        /** A credential exists in the repository's scope: present, not checked. */
        signedIn: z.boolean(),
        login: z.string(),
      }),
    ),
  }),
});

/** Runs a CLI's sign-in check inside the workspace's running sandbox. */
export const cliTestRpc = defineRpc({
  name: "cli.test",
  input: workspaceTargetSchema.extend({ id: cliIdSchema }),
  output: z.object({
    status: z.enum(["ok", "login", "not-mounted", "quota", "missing", "error"]),
    detail: z.string(),
  }),
});

/** Stores Claude's long-lived token: shared without a workspace, else where its repository keeps credentials. */
export const cliTokenRpc = defineRpc({
  name: "cli.token",
  input: z.object({ target: workspaceTargetSchema.nullable(), token: z.string() }),
  output: z.object({ scope: z.enum(CLI_SCOPES) }),
});
