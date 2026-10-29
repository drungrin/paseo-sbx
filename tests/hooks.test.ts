import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxSettingsSchema } from "../shared/settings";
import { SPEC_ENV } from "../shared/spec";
import { writeBinding } from "../server/bindings";
import { registerHooks } from "../server/hooks";
import { pluginPaths, type PluginPaths } from "../server/paths";
import { backfillWorkspaceRecords, resetWorkspaceBackfillForTests } from "../server/workspaces";

type Handler = (input: { request: Record<string, unknown> }, context: unknown) => Promise<unknown>;
type EventHandler = (event: Record<string, unknown>, context: unknown) => unknown;

let root: string;
let paths: PluginPaths;
let repo: string;
let handlers: Record<string, Handler>;
let events: Record<string, EventHandler>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-hooks-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  paths = pluginPaths({ XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(home, ".config") }, home);
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  handlers = {};
  events = {};
  resetWorkspaceBackfillForTests();
  const server = {
    before: (name: string, handler: Handler) => {
      handlers[name] = handler;
      return () => {};
    },
    on: (name: string, handler: EventHandler) => {
      events[name] = handler;
      return () => {};
    },
  } as unknown as PluginServerContext;
  registerHooks(server, { paths, readSettings: async () => sandboxSettingsSchema.parse({}) });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sessionOpen(request: Record<string, unknown>) {
  return handlers["agent.session_open"](
    {
      request: {
        agentId: "agent-1",
        workspaceId: "wks_1",
        provider: "claude-sbx",
        cwd: repo,
        reason: "resume",
        purpose: "interactive",
        env: {},
        ...request,
      },
    },
    {},
  ) as Promise<{ env: Record<string, string> }>;
}

describe("agent.session_open", () => {
  it("binds an interactive session to its sandbox and hands the wrapper a spec", async () => {
    const result = await sessionOpen({ reason: "create" });
    const spec = JSON.parse(result.env[SPEC_ENV]);
    expect(result.env.CLAUDE_CONFIG_DIR).toBe(spec.claudeConfigDir);
    expect(existsSync(spec.claudeConfigDir)).toBe(true);
    expect(readdirSync(paths.bindingsDir)).toEqual(["agent-1.json"]);
  });

  it("records the workspace's sandbox for the Sandbox terminal at every session, bound or not", async () => {
    const configDir = join(paths.claudeConfigs, "paseo-repo-0badc0de");
    writeBinding(paths, "agent-1", { key: "workspace:wks_1", name: "paseo-repo-0badc0de", claudeConfigDir: configDir });
    await sessionOpen({});
    const record = JSON.parse(readFileSync(join(paths.workspacesDir, "wks_1.json"), "utf8"));
    expect(record.name).toBe("paseo-repo-0badc0de");
    expect(record.env).toEqual({});
  });

  it("reads history without a spec, a new binding or a config dir", async () => {
    const unbound = await sessionOpen({ purpose: "history" });
    expect(unbound.env).toEqual({});
    expect(existsSync(paths.bindingsDir)).toBe(false);
    expect(existsSync(paths.claudeConfigs)).toBe(false);

    const configDir = join(paths.claudeConfigs, "paseo-repo-0badc0de");
    writeBinding(paths, "agent-1", { key: "workspace:wks_1", name: "paseo-repo-0badc0de", claudeConfigDir: configDir });
    const bound = await sessionOpen({ purpose: "history" });
    expect(bound.env).toEqual({ CLAUDE_CONFIG_DIR: configDir });
    expect(existsSync(configDir)).toBe(false);
  });
});

describe("workspace records for the Sandbox terminal", () => {
  it("records a new workspace, and fills the missing ones once from the first agent turn", async () => {
    await events["workspace.created"]({ workspace: { id: "wks_new", cwd: repo } }, {});
    expect(existsSync(join(paths.workspacesDir, "wks_new.json"))).toBe(true);
    // A sandbox never used gets no config dir from being recorded.
    expect(existsSync(paths.claudeConfigs)).toBe(false);

    writeFileSync(join(paths.workspacesDir, "wks_kept.json"), "{}");
    let listed = 0;
    const paseo = {
      workspaces: {
        list: async () => {
          listed++;
          return {
            entries: [
              { id: "wks_old", projectRootPath: repo, workspaceDirectory: repo },
              { id: "wks_kept", projectRootPath: repo },
              { id: "wks_gone", projectRootPath: join(root, "missing") },
            ],
            pageInfo: { hasMore: false, nextCursor: null },
          };
        },
      },
    };
    await Promise.all([events["agent.turn_started"]({}, { paseo }), events["agent.turn_started"]({}, { paseo })]);
    await backfillWorkspaceRecords(paths, async () => sandboxSettingsSchema.parse({}), paseo as never);
    expect(listed).toBe(1);
    expect(JSON.parse(readFileSync(join(paths.workspacesDir, "wks_old.json"), "utf8")).workspace).toBe(realpathSync(repo));

    // A sandbox already used has its config dir brought up to date: the link of old goes.
    const spec = JSON.parse(readFileSync(join(paths.workspacesDir, "wks_old.json"), "utf8"));
    mkdirSync(spec.claudeConfigDir, { recursive: true });
    symlinkSync(join(paths.hostClaudeDir, "settings.json"), join(spec.claudeConfigDir, "settings.json"));
    await events["workspace.created"]({ workspace: { id: "wks_old", cwd: repo } }, {});
    expect(existsSync(join(spec.claudeConfigDir, "settings.json"))).toBe(false);
    expect(readFileSync(join(paths.workspacesDir, "wks_kept.json"), "utf8")).toBe("{}");
    expect(existsSync(join(paths.workspacesDir, "wks_gone.json"))).toBe(false);
  });
});
