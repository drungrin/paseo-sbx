import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxSettingsSchema, type SandboxSettings } from "../shared/settings";
import { writeBinding } from "../server/bindings";
import type { ServerDeps } from "../server/hooks";
import { installBinFiles, pluginPaths, type PluginPaths } from "../server/paths";
import { recreateSandbox } from "../server/recreate";
import { listSandboxes, prepareSandbox } from "../server/sbx";
import { buildSpec } from "../server/spec-builder";
import { processStart, readSandboxState } from "../server/state";
import { ensureTemplatePrep, finishTemplatePrep, removeTemplate, saveTemplate } from "../server/templates";
import { installFakeSbx, type FakeSbx } from "./fake-sbx";

let root: string;
let paths: PluginPaths;
let fake: FakeSbx;
let workspace: string;
let settings: SandboxSettings;
let deps: ServerDeps;
const savedEnv = { ...process.env };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-sbx-ops-")));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  fake = installFakeSbx(root);
  writeFileSync(join(fake.bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fake.bin, "claude"), 0o755);
  Object.assign(process.env, fake.env);
  paths = pluginPaths({ XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(home, ".config") }, home);
  installBinFiles(paths);
  workspace = join(root, "app");
  mkdirSync(workspace);
  execFileSync("git", ["-C", workspace, "init", "-q"]);
  settings = sandboxSettingsSchema.parse({ claudeShared: [], isolation: "directory" });
  deps = { paths, readSettings: async () => settings };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

interface FakeAgent {
  archivedAt: string | null;
}

/** A Paseo API whose agents answer `refresh()` from a function, so a test can change them mid-operation. */
function fakePaseo(agent: (id: string, call: number) => FakeAgent | null) {
  let calls = 0;
  return {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const value = agent(id, calls++);
          return value ? { agent: { id, title: id, status: "idle", activeTurn: null, updatedAt: null, ...value } } : null;
        },
      }),
    },
  } as unknown as Parameters<typeof recreateSandbox>[1];
}

async function createdSandbox(): Promise<string> {
  const { spec } = await buildSpec({ settings, workspaceId: null, cwd: workspace, paths });
  await prepareSandbox(paths, spec);
  writeBinding(paths, "agent-1", { key: spec.key, name: spec.name, claudeConfigDir: spec.claudeConfigDir });
  return spec.name;
}

describe("recreate", () => {
  it("refuses while an agent of the sandbox is not archived, and touches nothing", async () => {
    const name = await createdSandbox();
    fake.clearCalls();
    await expect(recreateSandbox(deps, fakePaseo(() => ({ archivedAt: null })), name)).rejects.toThrow("is not archived");
    expect(fake.calls().some((call) => call.args[0] === "rm")).toBe(false);
  });

  it("refuses while a session still runs in the sandbox", async () => {
    const name = await createdSandbox();
    const leases = join(paths.locksDir, `${name}.leases`);
    mkdirSync(leases, { recursive: true });
    writeFileSync(join(leases, String(process.pid)), JSON.stringify({ pid: process.pid, start: processStart(process.pid), agentId: null }));
    await expect(recreateSandbox(deps, fakePaseo(() => ({ archivedAt: "x" })), name)).rejects.toThrow("session(s) still running");
  });

  it("aborts when an agent comes back between the first check and the lock", async () => {
    const name = await createdSandbox();
    fake.clearCalls();
    const paseo = fakePaseo((_id, call) => ({ archivedAt: call === 0 ? "x" : null }));
    await expect(recreateSandbox(deps, paseo, name)).rejects.toThrow("is not archived");
    expect(fake.calls().some((call) => call.args[0] === "rm")).toBe(false);
    expect(existsSync(join(paths.locksDir, `${name}.recreating`))).toBe(false);
    expect(existsSync(join(paths.locksDir, name))).toBe(false);
  });

  it("removes and recreates the sandbox with the current settings, keeping its transcripts", async () => {
    const name = await createdSandbox();
    const configDir = readSandboxState(paths, name)?.claudeConfigDir ?? "";
    mkdirSync(join(configDir, "projects"), { recursive: true });
    writeFileSync(join(configDir, "projects", "session.jsonl"), "transcript");
    settings = { ...settings, repos: { [readSandboxState(paths, name)?.repoKey ?? ""]: { template: "", memoryGiB: 5, mounts: [], envNames: [], autoPublish: [] } } };
    fake.clearCalls();

    await recreateSandbox(deps, fakePaseo(() => ({ archivedAt: "x" })), name);

    const verbs = fake.calls().map((call) => call.args[0]);
    expect(verbs.indexOf("rm")).toBeLessThan(verbs.lastIndexOf("create"));
    expect(fake.calls().find((call) => call.args[0] === "create")?.args).toEqual(expect.arrayContaining(["--memory", "5120m"]));
    expect(fake.sandboxes()).toEqual([name]);
    expect(readFileSync(join(configDir, "projects", "session.jsonl"), "utf8")).toBe("transcript");
    expect(existsSync(join(paths.locksDir, `${name}.recreating`))).toBe(false);
    expect(existsSync(join(paths.locksDir, name))).toBe(false);
  });
});

describe("templates", () => {
  it("saves a sandbox as a template through a pseudo-terminal", async () => {
    const name = await createdSandbox();
    expect(await saveTemplate(paths, name, "app:v1")).toBe("docker.io/library/app:v1");
    await expect(saveTemplate(paths, name, "Bad Tag")).rejects.toThrow("invalid template tag");
  });

  it("will not remove a template that settings still use", async () => {
    fake.setState({ templates: [{ id: "abc", repository: "docker.io/library/app", tag: "v1" }] });
    const inUse = sandboxSettingsSchema.parse({ repos: { "git:/r/.git": { template: "app:v1" } } });
    await expect(removeTemplate(paths, inUse, "docker.io/library/app:v1")).rejects.toThrow("is in use (git:/r/.git)");
    await removeTemplate(paths, sandboxSettingsSchema.parse({}), "docker.io/library/app:v1");
    expect(fake.calls().some((call) => call.args.join(" ") === "template rm --force docker.io/library/app:v1")).toBe(true);
  });

  it("prepares a clean sandbox per repository, reuses it, and removes it once saved", async () => {
    const first = await ensureTemplatePrep(deps, workspace);
    const create = fake.calls().find((call) => call.args[0] === "create");
    // No workspace, forwarded variables or credential mounts: just the agent.
    expect(create?.args.at(-1)).toBe("claude");
    expect(fake.calls().some((call) => call.args[0] === "policy")).toBe(true);
    expect(readSandboxState(paths, first.name)?.kind).toBe("template-prep");
    expect((await listSandboxes(paths)).find((sandbox) => sandbox.name === first.name)?.kind).toBe("template-prep");

    fake.clearCalls();
    expect((await ensureTemplatePrep(deps, workspace)).name).toBe(first.name);
    expect(fake.calls().some((call) => call.args[0] === "create")).toBe(false);

    expect(await finishTemplatePrep(paths, first.name, "app:clean")).toBe("docker.io/library/app:clean");
    expect(fake.sandboxes()).not.toContain(first.name);
    expect(readSandboxState(paths, first.name)).toBeNull();
  });
});
