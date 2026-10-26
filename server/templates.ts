import { totalmem } from "node:os";
import type { SandboxSettings } from "../shared/settings";
import { TEMPLATE_TAG_PATTERN, memoryMiB, normalizeTemplateRef, templatePrepName } from "../shared/spec";
import type { ServerDeps } from "./hooks";
import { newLockToken, withSandboxLock } from "./lock";
import type { PluginPaths } from "./paths";
import { repoIdentity } from "./repo";
import { SbxError, assertSandboxName, listSandboxes, removeSandbox, runSbx, runSbxOk, stopSandboxLocked } from "./sbx";
import { templateFor } from "./spec-builder";
import { liveLeases, writeSandboxState } from "./state";

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

/**
 * Saves the sandbox's filesystem as a template in the Paseo instance; returns its reference.
 * sbx saves only a stopped sandbox (it asks to stop a running one, and without a terminal that
 * question fails), so the sandbox is stopped first, shutting its Docker down cleanly. Stopping
 * would cut running sessions off: the plugin refuses while any is alive.
 */
export async function saveTemplate(paths: PluginPaths, name: string, tag: string): Promise<string> {
  assertSandboxName(name);
  if (!TEMPLATE_TAG_PATTERN.test(tag)) throw new Error(`invalid template tag: ${tag}`);
  return withSandboxLock(paths, name, newLockToken(), async () => {
    const sessions = liveLeases(paths, name);
    if (sessions.length > 0) {
      throw new Error(
        `saving stops ${name}, and ${sessions.length} session(s) still run in it: archive its agents, or use Prepare template`,
      );
    }
    await stopSandboxLocked(paths, name);
    const result = await runSbx(paths, ["template", "save", name, tag], 600_000);
    if (result.code !== 0) throw new SbxError("sbx template save", result);
    // sbx reports progress and the saved reference on stderr.
    const output = `${result.stdout}\n${result.stderr}`.replace(ANSI, "");
    const saved = /Saved template (\S+)/.exec(output)?.[1];
    if (!saved) throw new Error(`sbx template save did not report the template: ${output.trim().slice(-400)}`);
    return saved;
  });
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

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
