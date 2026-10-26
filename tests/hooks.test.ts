import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxSettingsSchema } from "../shared/settings";
import { SPEC_ENV } from "../shared/spec";
import { writeBinding } from "../server/bindings";
import { registerHooks } from "../server/hooks";
import { pluginPaths, type PluginPaths } from "../server/paths";

type Handler = (input: { request: Record<string, unknown> }, context: unknown) => Promise<unknown>;

let root: string;
let paths: PluginPaths;
let repo: string;
let handlers: Record<string, Handler>;

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
  const server = {
    before: (name: string, handler: Handler) => {
      handlers[name] = handler;
      return () => {};
    },
    on: () => () => {},
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
