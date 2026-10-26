import { spawn } from "node:child_process";
import { totalmem } from "node:os";
import type { SandboxSettings } from "../shared/settings";
import { TEMPLATE_TAG_PATTERN, memoryMiB, normalizeTemplateRef, templatePrepName } from "../shared/spec";
import type { ServerDeps } from "./hooks";
import { newLockToken, withSandboxLock } from "./lock";
import type { PluginPaths } from "./paths";
import { repoIdentity } from "./repo";
import { assertSandboxName, listSandboxes, removeSandbox, runSbxOk } from "./sbx";
import { templateFor } from "./spec-builder";
import { writeSandboxState } from "./state";

export interface TemplateInfo {
  /** `repository:tag` as `sbx template ls` reports it. */
  ref: string;
  id: string;
  createdAt: string | null;
  sizeBytes: number | null;
  /** sbx's own images. */
  base: boolean;
}

interface SbxTemplateEntry {
  id: string;
  repository: string;
  tag: string;
  created_at?: string;
  size?: number;
}

export async function listTemplates(paths: PluginPaths): Promise<TemplateInfo[]> {
  const stdout = await runSbxOk(paths, ["template", "ls", "--json"], "sbx template ls");
  return (JSON.parse(stdout || "[]") as SbxTemplateEntry[]).map((entry) => ({
    ref: `${entry.repository}:${entry.tag}`,
    id: entry.id,
    createdAt: entry.created_at ?? null,
    sizeBytes: entry.size ?? null,
    base: entry.repository === "docker.io/docker/sandbox-templates",
  }));
}

export function findTemplate(templates: readonly TemplateInfo[], ref: string): TemplateInfo | undefined {
  const wanted = normalizeTemplateRef(ref);
  return templates.find((template) => template.ref === wanted || template.id === ref);
}

/** Where settings reference a template: "default" for the global one, else repo keys. */
export function templateUsers(settings: SandboxSettings, ref: string): string[] {
  const wanted = normalizeTemplateRef(ref);
  const users: string[] = [];
  if (settings.template && normalizeTemplateRef(settings.template) === wanted) users.push("default");
  for (const [repoKey, repo] of Object.entries(settings.repos)) {
    if (repo.template && normalizeTemplateRef(repo.template) === wanted) users.push(repoKey);
  }
  return users;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/**
 * Runs an sbx command on a pseudo-terminal. sbx 0.49's `template save` queries the terminal and
 * refuses to run without one, asking for a --force flag the command does not have.
 */
function runSbxInPty(paths: PluginPaths, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const command = ["sbx", ...args].map(shellQuote).join(" ");
    const child = spawn("script", ["-qec", command, "/dev/null"], {
      env: { ...process.env, XDG_STATE_HOME: paths.stateHome },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error("saving a template needs the util-linux `script` command")
          : error,
      );
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      child.stdin.destroy();
      const clean = output.replace(ANSI, "").replace(/\r/g, "\n");
      if (signal) reject(new Error(`sbx ${args[0]} ${args[1] ?? ""} timed out`));
      else resolve({ code: code ?? 1, output: clean });
    });
  });
}

/** Saves the sandbox's filesystem as a template in the Paseo instance; returns its reference. */
export async function saveTemplate(paths: PluginPaths, name: string, tag: string): Promise<string> {
  assertSandboxName(name);
  if (!TEMPLATE_TAG_PATTERN.test(tag)) throw new Error(`invalid template tag: ${tag}`);
  return withSandboxLock(paths, name, newLockToken(), async () => {
    const result = await runSbxInPty(paths, ["template", "save", name, tag], 600_000);
    const saved = /Saved template (\S+)/.exec(result.output)?.[1];
    if (result.code !== 0 || !saved) {
      throw new Error(`sbx template save failed (exit ${result.code}): ${result.output.trim().slice(-800)}`);
    }
    return saved;
  });
}

export async function removeTemplate(paths: PluginPaths, settings: SandboxSettings, ref: string): Promise<void> {
  const users = templateUsers(settings, ref);
  if (users.length > 0) throw new Error(`${ref} is in use (${users.join(", ")}); pick another template there first`);
  await runSbxOk(paths, ["template", "rm", "--force", ref], `sbx template rm ${ref}`);
}

/**
 * The repo's template preparation sandbox: created from the repo's current template with no
 * workspace (sbx requires a writable primary workspace, and a template needs none), no forwarded
 * variables and no credential mounts, so saving it captures only what you install.
 */
export async function ensureTemplatePrep(deps: ServerDeps, cwd: string): Promise<{ name: string; repoKey: string }> {
  const { paths } = deps;
  const settings = await deps.readSettings();
  const repo = await repoIdentity(cwd);
  const name = templatePrepName(repo.key, repo.root);
  const existing = await listSandboxes(paths);
  if (existing.some((sandbox) => sandbox.name === name)) return { name, repoKey: repo.key };
  const template = templateFor(settings, repo.key);
  const args = ["create", "--name", name, "--memory", `${memoryMiB(settings, undefined, totalmem())}m`, "--no-progress"];
  if (template) {
    if (!findTemplate(await listTemplates(paths), template)) throw new Error(`template ${template} not found`);
    args.push("-t", template, "--pull", "never");
  }
  await runSbxOk(paths, [...args, "claude"], `sbx create ${name}`);
  await runSbxOk(
    paths,
    ["policy", "allow", "network", "--sandbox", name, settings.networkAllow.join(",")],
    "sbx policy allow",
  );
  writeSandboxState(paths, name, {
    kind: "template-prep",
    repoKey: repo.key,
    workspace: repo.root,
    template,
    policies: settings.networkAllow,
  });
  return { name, repoKey: repo.key };
}

/** Saves a preparation sandbox as a template and removes it. */
export async function finishTemplatePrep(paths: PluginPaths, name: string, tag: string): Promise<string> {
  const ref = await saveTemplate(paths, name, tag);
  await removeSandbox(paths, name);
  return ref;
}
