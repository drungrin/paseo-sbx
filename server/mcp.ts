import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MCP_HEADER_PATTERN, MCP_NAME_PATTERN, mcpAutoLoad, planMcp } from "../shared/mcp";
import type { McpServerView } from "../shared/rpc";
import type { SandboxSettings } from "../shared/settings";
import { newLockToken, withSandboxLock } from "./lock";
import type { PluginPaths } from "./paths";
import { SbxError, listSandboxes, runSbx, runSbxOk } from "./sbx";
import { readSandboxState, writeSandboxState } from "./state";

/** sbx printed something the plugin cannot read: its output format changed. */
export class McpFormatError extends Error {}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function parseSbxJson<T>(schema: z.ZodType<T>, stdout: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(stdout || "null");
  } catch {
    throw new McpFormatError(`${what} did not print JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new McpFormatError(`${what} printed an unexpected shape (${describeIssues(parsed.error)})`);
  return parsed.data;
}

const listSchema = z.array(
  z.object({ name: z.string(), status: z.string(), detail: z.string().optional(), next_step: z.string().optional() }),
);

const inspectSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  requires_oauth: z.boolean().optional(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  header_secrets: z.array(z.object({ placeholder: z.string(), stored: z.boolean() })).optional(),
});
type McpDetails = z.infer<typeof inspectSchema>;

async function listRegistered(paths: PluginPaths) {
  return parseSbxJson(listSchema, await runSbxOk(paths, ["mcp", "ls", "--json"], "sbx mcp ls"), "sbx mcp ls --json");
}

async function inspect(paths: PluginPaths, name: string): Promise<McpDetails> {
  const stdout = await runSbxOk(paths, ["mcp", "inspect", name, "--json"], `sbx mcp inspect ${name}`);
  return parseSbxJson(inspectSchema, stdout, `sbx mcp inspect ${name} --json`);
}

/** sbx's records of each sandbox's MCP gateway (sbx 0.49). */
export function gatewaysDir(paths: PluginPaths): string {
  return join(paths.stateHome, "sandboxes", "sandboxes", "sandboxd", "mcp", "gateways");
}

const gatewaySchema = z.object({ runtime_id: z.string(), dynamic_added_set: z.array(z.string()).optional() });

export type LoadedMcp = { loaded: string[]; unreadable: null } | { loaded: null; unreadable: string };

/**
 * The servers a sandbox's gateway has loaded. sbx has no command that lists them for a local
 * sandbox, so this reads sbx's own record of it; when sbx changes that record, `unreadable` says
 * what no longer fits instead of guessing. sbx 0.49 writes the record when the gateway first
 * starts: a sandbox that never ran may have none yet, a running one always has it.
 */
export function readLoadedMcp(paths: PluginPaths, name: string, running: boolean): LoadedMcp {
  const file = join(gatewaysDir(paths), `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { loaded: null, unreadable: `${file}: ${(error as Error).message}` };
    return running
      ? { loaded: null, unreadable: `${file} does not exist for a running sandbox` }
      : { loaded: [], unreadable: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { loaded: null, unreadable: `${file} is not JSON` };
  }
  const parsed = gatewaySchema.safeParse(value);
  if (!parsed.success) return { loaded: null, unreadable: `${file}: ${describeIssues(parsed.error)}` };
  return { loaded: [...(parsed.data.dynamic_added_set ?? [])].sort(), unreadable: null };
}

function view(entry: z.infer<typeof listSchema>[number], details: McpDetails | null, loadedIn: string[]): McpServerView {
  return {
    name: entry.name,
    url: details?.url ?? null,
    status: entry.status,
    detail: entry.detail ?? null,
    nextStep: entry.next_step ?? null,
    auth: details?.headers?.length ? "api-key" : details?.requires_oauth ? "oauth" : "none",
    loadedIn,
  };
}

export interface McpRegistry {
  servers: McpServerView[];
  sandboxes: number;
  unrecognized: string | null;
}

/** The registered servers, each with the working sandboxes whose gateway has it loaded. */
export async function listMcpServers(paths: PluginPaths): Promise<McpRegistry> {
  const working = (await listSandboxes(paths)).filter((sandbox) => sandbox.kind === "working");
  const problems = new Set<string>();
  let entries: z.infer<typeof listSchema>;
  try {
    entries = await listRegistered(paths);
  } catch (error) {
    if (error instanceof McpFormatError) return { servers: [], sandboxes: working.length, unrecognized: error.message };
    throw error;
  }
  const loadedIn = new Map<string, string[]>();
  for (const sandbox of working) {
    const record = readLoadedMcp(paths, sandbox.name, sandbox.status === "running");
    if (record.unreadable !== null) problems.add(record.unreadable);
    for (const name of record.loaded ?? []) loadedIn.set(name, [...(loadedIn.get(name) ?? []), sandbox.name]);
  }
  const servers = await Promise.all(
    entries.map(async (entry) => {
      let details: McpDetails | null = null;
      try {
        details = await inspect(paths, entry.name);
      } catch (error) {
        if (!(error instanceof McpFormatError)) throw error;
        problems.add(error.message);
      }
      return view(entry, details, loadedIn.get(entry.name) ?? []);
    }),
  );
  return { servers, sandboxes: working.length, unrecognized: [...problems][0] ?? null };
}

export interface NewMcpServer {
  name: string;
  url: string;
  apiKey: { header: string; value: string } | null;
}

/**
 * Registers a remote server without signing in (`--skip-auth`): an OAuth one then shows as
 * needing a sign-in, which runs on its own. An API key goes to sbx's secret store over stdin and
 * reaches the server in `header` through the gateway; `Authorization` gets the Bearer scheme.
 */
export async function addMcpServer(paths: PluginPaths, input: NewMcpServer): Promise<McpServerView> {
  if (!MCP_NAME_PATTERN.test(input.name)) {
    throw new Error("Name it with letters, digits, dots, dashes and underscores, starting with a letter or digit");
  }
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new Error("The address must be a full URL, such as https://mcp.example.com/mcp");
  }
  // Its sign-in token or API key travels in every request.
  if (url.protocol !== "https:") throw new Error("Only https:// servers: their sign-in or API key travels with every request");
  if (input.apiKey && !MCP_HEADER_PATTERN.test(input.apiKey.header))
    throw new Error("The header name takes letters, digits and dashes");
  if ((await listRegistered(paths)).some((entry) => entry.name === input.name)) {
    throw new Error(`A server named ${input.name} is already registered`);
  }
  const args = ["mcp", "add", input.name, "--url", url.href, "--skip-auth"];
  if (input.apiKey) {
    const scheme = input.apiKey.header.toLowerCase() === "authorization" ? "Bearer " : "";
    // sbx fills the placeholder from the secret `mcp:<name>:api-key` at connect time.
    args.push("--header", `${input.apiKey.header}: ${scheme}` + "${api-key}");
  }
  await runSbxOk(paths, args, `sbx mcp add ${input.name}`, 120_000);
  if (input.apiKey) {
    const result = await runSbx(paths, ["secret", "set", `mcp:${input.name}:api-key`], 60_000, {}, input.apiKey.value.trim());
    if (result.code !== 0) {
      await runSbx(paths, ["mcp", "rm", input.name, "--force"]);
      throw new SbxError(`sbx secret set mcp:${input.name}:api-key`, result);
    }
  }
  const entry = (await listRegistered(paths)).find((candidate) => candidate.name === input.name);
  if (!entry) throw new Error(`sbx did not list ${input.name} after adding it`);
  return view(entry, await inspect(paths, input.name), []);
}

const NOT_LOADED = /is not loaded|is not registered/;

/** Unloads one server from a running sandbox; one that is not loaded counts as done. */
async function unload(paths: PluginPaths, sandbox: string, name: string): Promise<string | null> {
  const result = await runSbx(paths, ["mcp", "unload", name, "--sandbox", sandbox]);
  const output = (result.stderr || result.stdout).trim();
  return result.code === 0 || NOT_LOADED.test(output) ? null : output || `exit ${result.code}`;
}

async function load(paths: PluginPaths, sandbox: string, name: string): Promise<string | null> {
  const result = await runSbx(paths, ["mcp", "load", name, "--sandbox", sandbox], 120_000);
  return result.code === 0 ? null : (result.stderr || result.stdout).trim() || `exit ${result.code}`;
}

/**
 * Unloads the server from every sandbox (sbx's `mcp rm` leaves it loaded), then removes it with
 * the secrets its headers use. A stopped sandbox unloads it when it next starts.
 */
export async function removeMcpServer(paths: PluginPaths, name: string): Promise<void> {
  if (!(await listRegistered(paths)).some((entry) => entry.name === name)) throw new Error(`${name} is not registered`);
  const details = await inspect(paths, name).catch(() => null);
  for (const sandbox of await listSandboxes(paths)) {
    const record = readLoadedMcp(paths, sandbox.name, sandbox.status === "running");
    if (record.loaded && !record.loaded.includes(name)) continue;
    const error = sandbox.status === "running" ? await unload(paths, sandbox.name, name) : null;
    if (error) throw new Error(`unloading ${name} from ${sandbox.name}: ${error}`);
    const waits = sandbox.status !== "running" && record.loaded !== null;
    await withSandboxLock(paths, sandbox.name, newLockToken(), async () => {
      const state = readSandboxState(paths, sandbox.name);
      if (!state) return;
      const errors = { ...state.mcpErrors };
      delete errors[name];
      writeSandboxState(paths, sandbox.name, {
        ...state,
        mcpAutoLoad: (state.mcpAutoLoad ?? []).filter((entry) => entry !== name),
        mcpUnload: [...new Set([...(state.mcpUnload ?? []), ...(waits ? [name] : [])])],
        mcpErrors: errors,
      });
    });
  }
  await runSbxOk(paths, ["mcp", "rm", name, "--force"], `sbx mcp rm ${name}`);
  for (const secret of details?.header_secrets ?? []) {
    await runSbx(paths, ["secret", "rm", `mcp:${name}:${secret.placeholder}`, "-f"]);
  }
}

/**
 * Brings every working sandbox's gateway to its repository's MCP choices (`planMcp`). Loading
 * works on a stopped sandbox, which gets the server when it starts; unloading needs it running,
 * so a stopped one keeps the server listed in `mcpUnload` for its next launch.
 */
export async function applyMcpChoices(paths: PluginPaths, settings: SandboxSettings): Promise<void> {
  for (const sandbox of await listSandboxes(paths)) {
    if (sandbox.kind !== "working") continue;
    const state = readSandboxState(paths, sandbox.name);
    if (!state?.repoKey) continue;
    const wanted = mcpAutoLoad(settings, state.repoKey);
    const before = state.mcpAutoLoad ?? [];
    const plan = planMcp({
      wanted,
      before,
      pending: state.mcpUnload ?? [],
      loaded: readLoadedMcp(paths, sandbox.name, sandbox.status === "running").loaded,
    });
    if (plan.load.length === 0 && plan.unload.length === 0 && before.join() === wanted.join()) continue;
    const errors: Record<string, string> = {};
    for (const name of plan.load) {
      const error = await load(paths, sandbox.name, name);
      if (error) errors[name] = error;
    }
    const waiting: string[] = [];
    for (const name of plan.unload) {
      const error = sandbox.status === "running" ? await unload(paths, sandbox.name, name) : "the sandbox is stopped";
      if (error === null) continue;
      waiting.push(name);
      if (sandbox.status === "running") errors[name] = error;
    }
    await withSandboxLock(paths, sandbox.name, newLockToken(), async () => {
      const current = readSandboxState(paths, sandbox.name);
      if (!current) return;
      writeSandboxState(paths, sandbox.name, { ...current, mcpAutoLoad: wanted, mcpUnload: waiting, mcpErrors: errors });
    });
  }
}
