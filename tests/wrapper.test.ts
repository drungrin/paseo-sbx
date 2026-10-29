import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPEC_ENV, type SandboxSpec } from "../shared/spec";
import {
  SEED_SETTINGS_SOURCE,
  SHELL_RC_SOURCE,
  SUPERVISOR_SOURCE,
  WRAPPER_SOURCE,
  launcherSource,
} from "../server/wrapper-source";
import { processStart } from "../server/state";
import { FAKE_SBX } from "./fake-sbx";

// A fake claude that reports what it received and echoes the first stdin line. With
// CLAUDE_FAKE_BUSY it behaves like Claude in the middle of a tool call: stdin closing does not
// stop it.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.CLAUDE_FAKE_COOPERATIVE) {
  // Ends its session on stdin EOF but leaves a detached tool that ignores SIGTERM.
  require('node:child_process').spawn('sh', ['-c', 'trap "" TERM; sleep 300'], { stdio: 'ignore', detached: true });
  fs.readFileSync(0);
} else if (process.env.CLAUDE_FAKE_BUSY) {
  require('node:child_process').spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
  setInterval(() => {}, 1000);
} else {
  const input = fs.readFileSync(0, 'utf8').split('\\n')[0];
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env, input }));
}
`;

let root: string;
let home: string;
let bin: string;
let wrapper: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-wrapper-"));
  home = join(root, "home");
  bin = join(root, "fakebin");
  workspace = join(root, "workspace");
  for (const dir of [home, bin, workspace]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, "sbx"), FAKE_SBX);
  for (const cli of ["claude", "codex"]) {
    writeFileSync(join(bin, cli), FAKE_CLAUDE);
    chmodSync(join(bin, cli), 0o755);
  }
  chmodSync(join(bin, "sbx"), 0o755);
  // Installed like the plugin does: in the bin dir, next to which catalog/ holds the records.
  mkdirSync(join(root, "state", "bin"), { recursive: true });
  wrapper = join(root, "state", "bin", "paseo-sbx-claude.cjs");
  writeFileSync(wrapper, WRAPPER_SOURCE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  const state = join(root, "state");
  mkdirSync(join(state, "bin"), { recursive: true });
  writeFileSync(join(state, "bin", "guest-supervisor.py"), SUPERVISOR_SOURCE);
  return {
    version: 3,
    agent: "claude",
    binary: "claude",
    kit: "claude",
    agentCwd: workspace,
    agentHome: null,
    homesDir: join(state, "homes"),
    name: "paseo-workspace-0000abcd",
    key: "workspace:wks_1",
    repoKey: `dir:${workspace}`,
    template: null,
    allowImageDownloads: true,
    stateHome: join(state, "sbx"),
    stateDir: join(state, "sandboxes"),
    locksDir: join(state, "locks"),
    runDir: join(state, "run"),
    binDir: join(state, "bin"),
    workspace,
    mounts: [join(root, "missing-mount"), `${home}:ro`],
    homeMounts: [],
    dockerDisk: null,
    memory: "3072m",
    cpus: 0,
    networkAllow: ["**"],
    forwardPorts: [],
    autoPublish: [],
    env: { LICENSE_KEY: "s3cret-value" },
    claudeConfigDir: join(state, "claude", "paseo-workspace-0000abcd"),
    ...overrides,
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: { args: string[]; stateHome: string; envNames: string[]; dockerSize?: string }[];
}

function run(args: string[], options: { cwd?: string; env?: Record<string, string>; input?: string } = {}): Run {
  const log = join(root, "sbx.log");
  rmSync(log, { force: true });
  const result = spawnSync(process.execPath, [wrapper, ...args], {
    cwd: options.cwd ?? workspace,
    input: options.input ?? "",
    encoding: "utf8",
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      FAKE_SBX_STATE: join(root, "sbx-state.json"),
      FAKE_SBX_LOG: log,
      ...options.env,
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

const PROBE_ARGS = [
  "--output-format",
  "stream-json",
  "--setting-sources=user",
  "--strict-mcp-config",
  "--tools",
  "",
  "--no-session-persistence",
];

/** The catalog record the plugin writes when Claude is configured, and its sandbox in the fake sbx. */
function catalog() {
  const state = join(root, "state");
  const workdir = join(state, "catalog", "claude");
  mkdirSync(join(workdir, "claude-config"), { recursive: true });
  writeFileSync(join(state, "bin", "guest-supervisor.py"), SUPERVISOR_SOURCE);
  const hostSettings = join(home, ".claude", "settings.json");
  mkdirSync(dirname(hostSettings), { recursive: true });
  writeFileSync(hostSettings, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "gateway-token", ANTHROPIC_BASE_URL: "https://gw.example" } }));
  const record = {
    version: 1,
    agent: "claude",
    name: "paseo-catalog-claude-0000beef",
    stateHome: join(state, "sbx"),
    runDir: join(state, "run"),
    binDir: join(state, "bin"),
    workdir,
    binary: "claude",
    cliVersion: "2.1.306 (Claude Code)",
    claudeConfigDir: join(workdir, "claude-config"),
    agentHome: null,
    hostSettings,
    ports: [],
    createdAt: "2026-10-26T00:00:00.000Z",
  };
  writeFileSync(join(state, "catalog", "claude.json"), JSON.stringify(record));
  writeFileSync(join(root, "sbx-state.json"), JSON.stringify({ sandboxes: [record.name] }));
  return record;
}

describe("wrapper without a session", () => {
  it("runs Paseo's catalog probe in the agent's catalog sandbox, with Claude's settings env only in the run", () => {
    const record = catalog();
    const result = run(PROBE_ARGS, { cwd: home, input: "hello\n" });
    expect(result.status).toBe(0);
    expect(result.calls.map((call) => call.args[0])).toEqual(["exec"]);
    const exec = result.calls[0];
    expect(exec.args).toEqual(expect.arrayContaining(["-w", record.workdir, record.name, "claude", ...PROBE_ARGS]));
    expect(exec.args.join(" ")).not.toContain("gateway-token");
    expect(exec.envNames).not.toContain("ANTHROPIC_AUTH_TOKEN");
    const guest = JSON.parse(result.stdout);
    expect(guest.args).toEqual(PROBE_ARGS);
    expect(guest.cwd).toBe(record.workdir);
    expect(guest.env.ANTHROPIC_AUTH_TOKEN).toBe("gateway-token");
    expect(guest.env.CLAUDE_CONFIG_DIR).toBe(record.claudeConfigDir);
  });

  it("answers the version from the catalog record and runs other queries in the catalog", () => {
    catalog();
    const version = run(["--version"], { cwd: workspace });
    expect(version.status).toBe(0);
    expect(version.stdout).toBe("2.1.306 (Claude Code)\n");
    expect(version.calls.some((call) => call.args[0] === "create")).toBe(false);

    const login = run(["auth", "status"], { cwd: workspace });
    expect(login.status).toBe(0);
    expect(JSON.parse(login.stdout).args).toEqual(["auth", "status"]);
  });

  it("fails closed for a session without a spec, and asks to configure an agent without a catalog", () => {
    catalog();
    const session = run(["--output-format", "stream-json"], { cwd: home, env: { PASEO_AGENT_ID: "agent-1" } });
    expect(session.status).toBe(1);
    expect(session.stderr).toContain("claude-sbx sessions need the paseo-sbx plugin enabled");
    expect(session.calls).toEqual([]);

    rmSync(join(root, "state", "catalog", "claude.json"));
    const probe = run(PROBE_ARGS, { cwd: home });
    expect(probe.status).toBe(1);
    expect(probe.stderr).toContain("press Configure");
    expect(probe.calls).toEqual([]);
  });

  it("tells an agent id the daemon itself inherited apart from a session's", () => {
    catalog();
    // The daemon runs with PASEO_AGENT_ID (started from an agent session); its probes inherit it.
    const daemon = spawnSync(
      process.execPath,
      ["-e", `require("node:child_process").spawnSync(process.execPath, ${JSON.stringify([wrapper, "--version"])}, { stdio: "inherit" })`],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: home,
          PASEO_AGENT_ID: "the-daemons-own",
          FAKE_SBX_STATE: join(root, "sbx-state.json"),
          FAKE_SBX_LOG: join(root, "sbx.log"),
        },
      },
    );
    expect(daemon.stdout).toBe("2.1.306 (Claude Code)\n");
  });

  it("runs the history the plugin routes to the catalog despite the agent id", () => {
    catalog();
    const result = run(["--resume", "x"], { cwd: home, env: { PASEO_AGENT_ID: "agent-1", PASEO_SBX_ROUTE: "catalog" } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).args).toEqual(["--resume", "x"]);
  });
});

describe("wrapper", () => {

  it("creates the sandbox once, applies its policy once, and runs claude inside it", () => {
    const sandbox = spec();
    const env = {
      [SPEC_ENV]: JSON.stringify(sandbox),
      ANTHROPIC_MODEL: "m",
      PASEO_HOME: "/host/only",
      UNRELATED: "x",
    };
    const first = run(["--model", "m", "--input-format", "stream-json"], { env, input: '{"type":"user"}\n' });
    expect(first.status).toBe(0);

    const create = first.calls.find((call) => call.args[0] === "create");
    expect(create?.args).toEqual([
      "create",
      "--name",
      sandbox.name,
      "--memory",
      "3072m",
      "--no-progress",
      "claude",
      workspace,
      `${home}:ro`,
      `${sandbox.binDir}:ro`,
      sandbox.claudeConfigDir,
    ]);
    expect(first.stderr).toContain("skipping missing mount");
    expect(first.calls.every((call) => call.stateHome === sandbox.stateHome)).toBe(true);
    expect(first.calls.filter((call) => call.args[0] === "policy").map((call) => call.args)).toEqual([
      ["policy", "allow", "network", "--sandbox", sandbox.name, "**"],
    ]);

    const guest = JSON.parse(first.stdout);
    expect(guest.args).toEqual(["--model", "m", "--input-format", "stream-json"]);
    expect(guest.cwd).toBe(workspace);
    expect(guest.input).toBe('{"type":"user"}');
    expect(guest.env.LICENSE_KEY).toBe("s3cret-value");
    expect(guest.env.ANTHROPIC_MODEL).toBe("m");
    expect(guest.env.CLAUDE_CONFIG_DIR).toBe(sandbox.claudeConfigDir);
    expect(guest.env.PASEO_SBX_SANDBOX).toBe(sandbox.name);
    expect(guest.env[SPEC_ENV]).toBeUndefined();
    expect(guest.env.PASEO_HOME).toBeUndefined();
    expect(guest.env.UNRELATED).toBeUndefined();

    // Secrets reach the guest through a private env file: never on a command line, never in
    // the environment of an sbx process (which could start the sandbox daemon with it).
    const exec = first.calls.find((call) => call.args[0] === "exec" && call.args[1] === "-i");
    expect(exec?.args.join(" ")).not.toContain("s3cret-value");
    expect(exec?.args).toContain("--env-file");
    for (const call of first.calls) {
      expect(call.envNames).not.toContain("LICENSE_KEY");
      expect(call.envNames).not.toContain("ANTHROPIC_MODEL");
      expect(call.envNames).not.toContain(SPEC_ENV);
    }
    expect(readdirSync(sandbox.runDir)).toEqual([]);

    const second = run(["--model", "m"], { env });
    expect(second.status).toBe(0);
    expect(second.calls.some((call) => call.args[0] === "create")).toBe(false);
    expect(second.calls.some((call) => call.args[0] === "policy")).toBe(false);
  });

  it("forwards detected loopback ports through the policy", () => {
    const sandbox = spec();
    const mcp = JSON.stringify({ mcpServers: { paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents" } } });
    // ensure mode stops before the forwarder, which needs a real guest.
    const result = run(["--paseo-sbx-ensure", "--mcp-config", mcp], {
      env: { [SPEC_ENV]: JSON.stringify(sandbox), ANTHROPIC_BASE_URL: "http://localhost:8317/" },
    });
    expect(result.status).toBe(0);
    expect(result.calls.find((call) => call.args[0] === "policy")?.args.at(-1)).toBe(
      "**,localhost:6767,localhost:8317",
    );
    expect(result.calls.some((call) => call.args[0] === "exec")).toBe(false);
  });

  it("rejects a spec from an incompatible plugin version", () => {
    const result = run([], { env: { [SPEC_ENV]: JSON.stringify({ ...spec(), version: 99 }) } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported PASEO_SBX_SPEC version 99");
  });

  it("stops the guest tree when the daemon signals the wrapper", async () => {
    const session = startSession();
    const guest = await waitForGuest();
    session.kill("SIGTERM");
    await exited(session);
    await waitFor(() => !alive(guest.claude) && !alive(guest.tool));
  });

  it("stops the guest tree when the sbx client dies first", async () => {
    const session = startSession();
    const guest = await waitForGuest();
    const client = Number(execFileSync("ps", ["-o", "pid=", "--ppid", String(session.pid)], { encoding: "utf8" }).trim());
    process.kill(client, "SIGKILL");
    await exited(session);
    await waitFor(() => !alive(guest.claude) && !alive(guest.tool));
  });

  it("stops the guest tree when the sbx client exits cleanly while the guest is busy", async () => {
    const session = startSession({ FAKE_SBX_DETACH: "1" });
    await exited(session);
    expect(session.exitCode).toBe(0);
    const guest = await waitForGuest();
    await waitFor(() => !alive(guest.claude) && !alive(guest.tool));
  });

  it("stops the guest tree when the session's stdin closes", async () => {
    const session = startSession();
    const guest = await waitForGuest();
    session.stdin?.end();
    await waitFor(() => !alive(guest.claude) && !alive(guest.tool));
    await exited(session);
  });
});

// A session whose guest is busy with a tool call when the session ends.
function startSession(extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, [wrapper, "--input-format", "stream-json"], {
    cwd: workspace,
    stdio: ["pipe", "ignore", "ignore"],
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      FAKE_SBX_STATE: join(root, "sbx-state.json"),
      FAKE_SBX_LOG: join(root, "sbx.log"),
      [SPEC_ENV]: JSON.stringify(spec()),
      CLAUDE_FAKE_BUSY: "1",
      PASEO_SBX_STOP_GRACE: "0.5",
      ...extraEnv,
    },
  });
}

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The busy fake claude and the tool-like sleep it started.
async function waitForGuest(): Promise<{ claude: number; tool: number }> {
  return waitFor(() => {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((row) => row.length >= 3);
    const claude = rows.find((row) => row.slice(2).join(" ").includes(`${bin}/claude`) && !row.join(" ").includes("guest-supervisor"));
    if (!claude) return null;
    const tool = rows.find((row) => row[1] === claude[0] && row[2] === "sleep");
    return tool ? { claude: Number(claude[0]), tool: Number(tool[0]) } : null;
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.on("exit", () => resolve());
  });
}

describe("wrapper hardening", () => {
  it("revokes network rules the spec no longer lists", () => {
    const first = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(spec()) } });
    expect(first.status).toBe(0);
    const second = run(["--paseo-sbx-ensure"], {
      env: { [SPEC_ENV]: JSON.stringify(spec({ networkAllow: ["example.com"] })) },
    });
    expect(second.status).toBe(0);
    expect(second.calls.filter((call) => call.args[0] === "policy").map((call) => call.args.slice(1))).toEqual([
      ["allow", "network", "--sandbox", spec().name, "example.com"],
      ["rm", "network", "--sandbox", spec().name, "--resource", "**", "--force"],
    ]);
  });

  it("keeps a session's host port rules when the plugin prepares the sandbox on its own", () => {
    const sandbox = spec();
    const mcp = JSON.stringify({ mcpServers: { paseo: { type: "http", url: "http://127.0.0.1:6790/mcp/agents" } } });
    // A session adds the MCP port; ensure mode runs without the session's arguments.
    expect(run(["--mcp-config", mcp], { env: { [SPEC_ENV]: JSON.stringify(sandbox) }, input: "{}\n" }).status).toBe(0);
    const prepared = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(prepared.status).toBe(0);
    expect(prepared.calls.some((call) => call.args[0] === "policy" && call.args[1] === "rm")).toBe(false);
    const control = JSON.parse(readFileSync(join(sandbox.claudeConfigDir, ".paseo-sbx", "relays.json"), "utf8"));
    expect(control.internal).toContain(6790);
  });

  it("relays loopback ports named by forwarded variables", () => {
    const sandbox = spec({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999/" } });
    const result = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(result.status).toBe(0);
    expect(result.calls.find((call) => call.args[0] === "policy")?.args.at(-1)).toBe("**,localhost:9999");
  });

  it("never lets forwarded variables redirect the host-side sbx client", () => {
    const sandbox = spec({ env: { XDG_STATE_HOME: "/elsewhere", SBX_TOKEN: "x", GOOD: "1" } });
    const result = run([], { env: { [SPEC_ENV]: JSON.stringify(sandbox) }, input: "{}\n" });
    expect(result.status).toBe(0);
    expect(result.calls.every((call) => call.stateHome === sandbox.stateHome)).toBe(true);
    const guest = JSON.parse(result.stdout);
    expect(guest.env.GOOD).toBe("1");
    expect(guest.env.XDG_STATE_HOME).toBeUndefined();
    expect(guest.env.SBX_TOKEN).toBeUndefined();
    expect(result.stderr).toContain("not forwarding reserved variable XDG_STATE_HOME");
  });

  it("releases the sandbox lock when a step fails", () => {
    const sandbox = spec();
    const failed = run(["--paseo-sbx-ensure"], {
      env: { [SPEC_ENV]: JSON.stringify(sandbox), FAKE_SBX_FAIL_CREATE: "1" },
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("create refused");
    expect(existsSync(join(sandbox.locksDir, sandbox.name))).toBe(false);
    const started = Date.now();
    expect(run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } }).status).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("takes over a lock whose owner died", () => {
    const sandbox = spec();
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    mkdirSync(join(sandbox.locksDir, sandbox.name), { recursive: true });
    writeFileSync(join(sandbox.locksDir, sandbox.name, "owner"), dead.stdout);
    const started = Date.now();
    expect(run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } }).status).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("kills tools that ignore SIGTERM after Claude ends its session", async () => {
    const session = startSession({ CLAUDE_FAKE_BUSY: "", CLAUDE_FAKE_COOPERATIVE: "1" });
    const tools = await waitForTools();
    session.stdin?.end();
    await exited(session);
    await waitFor(() => tools.every((pid) => !alive(pid)));
  });

  it("passes forwarded values literally and keeps multi-line ones out of the env file", () => {
    const sandbox = spec({ env: { SPECIAL: `a=b "c" #d  'e'`, PEM: "line1\nline2" } });
    const result = run([], { env: { [SPEC_ENV]: JSON.stringify(sandbox) }, input: "{}\n" });
    expect(result.status).toBe(0);
    const guest = JSON.parse(result.stdout);
    expect(guest.env.SPECIAL).toBe(`a=b "c" #d  'e'`);
    expect(guest.env.PEM).toBe("line1\nline2");
    expect(result.stderr).toContain("passing PEM through the sbx client environment");
    const exec = result.calls.find((call) => call.args[0] === "exec" && call.args[1] === "-i");
    expect(exec?.args).toEqual(expect.arrayContaining(["-e", "PEM"]));
    expect(exec?.envNames).not.toContain("SPECIAL");
  });

  it("gives Claude sessions the env of your Claude settings, under the forwarded variables", () => {
    const hostSettings = join(root, "host-claude-settings.json");
    writeFileSync(
      hostSettings,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://gateway.test:1", LICENSE_KEY: "from-settings", HOME: "/x" } }),
    );
    const sandbox = spec({ env: { LICENSE_KEY: "from-file" }, hostClaudeSettings: hostSettings });
    const result = run([], { env: { [SPEC_ENV]: JSON.stringify(sandbox) }, input: "{}\n" });
    expect(result.status).toBe(0);
    const guest = JSON.parse(result.stdout);
    expect(guest.env.ANTHROPIC_BASE_URL).toBe("http://gateway.test:1");
    expect(guest.env.LICENSE_KEY).toBe("from-file");
    expect(guest.env.HOME).not.toBe("/x");
    const exec = result.calls.find((call) => call.args[0] === "exec" && call.args[1] === "-i");
    expect(exec?.args.join(" ")).not.toContain("gateway.test");

    const codex = spec({ agent: "codex", binary: "claude", env: {}, hostClaudeSettings: hostSettings });
    const other = run([], { env: { [SPEC_ENV]: JSON.stringify(codex) }, input: "{}\n" });
    expect(other.status).toBe(0);
    expect(JSON.parse(other.stdout).env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("starts the sandbox's own Claude settings from the kit's, once, without its apiKeyHelper", () => {
    const home = join(root, "guest-home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ apiKeyHelper: "echo proxy-managed", permissions: { defaultMode: "bypassPermissions" } }),
    );
    const config = join(root, "config");
    mkdirSync(config, { recursive: true });
    const script = join(root, "seed.py");
    writeFileSync(script, SEED_SETTINGS_SOURCE);
    const seed = () => execFileSync("python3", [script, config], { env: { HOME: home, PATH: process.env.PATH } });
    seed();
    expect(JSON.parse(readFileSync(join(config, "settings.json"), "utf8"))).toEqual({
      permissions: { defaultMode: "bypassPermissions" },
    });
    writeFileSync(join(config, "settings.json"), '{"enabledPlugins":{"x@y":true}}');
    seed();
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"enabledPlugins":{"x@y":true}}');
  });

  it("gives claude started in the Sandbox terminal sbx's MCP gateway, except for its subcommands", () => {
    const bin = join(root, "fake-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
    const rc = join(root, "shellrc");
    writeFileSync(rc, SHELL_RC_SOURCE);
    const call = (args: string) =>
      execFileSync("bash", ["--norc", "--noprofile", "-c", `eval "$(sed -n '/^claude()/,/^}/p' ${rc})"; claude ${args}`], {
        env: { PATH: `${bin}:${process.env.PATH}`, MCP_GATEWAY_URL: "http://gw.test/mcp", MCP_SENTINEL_TOKEN_NAME: "tok" },
        encoding: "utf8",
      });
    const session = call("-p hi").split("|");
    expect(session[0]).toBe("--mcp-config");
    expect(JSON.parse(session[1])).toEqual({
      mcpServers: { "mcp-gateway": { type: "http", url: "http://gw.test/mcp", headers: { Authorization: "Bearer tok" } } },
    });
    expect(session.slice(2, 4)).toEqual(["-p", "hi"]);
    expect(call("mcp list")).toBe("mcp|list|");
  });

  it("removes env files left by sessions that died", () => {
    const sandbox = spec();
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    mkdirSync(sandbox.runDir, { recursive: true });
    writeFileSync(join(sandbox.runDir, `env-${dead.stdout}.list`), "TOKEN=x\n");
    expect(run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } }).status).toBe(0);
    expect(readdirSync(sandbox.runDir)).toEqual([]);
  });

  it("says what to do when sbx cannot read its login", () => {
    const result = run(["--paseo-sbx-ensure"], {
      env: { [SPEC_ENV]: JSON.stringify(spec()), FAKE_SBX_LS_ERROR: "error: not signed in to Docker" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unlock the OS keyring");
  });

  it("launches the wrapper through an agent's launcher with arguments intact", () => {
    const dir = join(root, "it's a dir");
    mkdirSync(dir);
    const script = join(dir, "echo-args.cjs");
    writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE, agent: process.env.PASEO_SBX_AGENT }));",
    );
    const launcher = join(dir, "launcher");
    writeFileSync(launcher, launcherSource(process.execPath, script, "codex"));
    chmodSync(launcher, 0o755);
    // Paseo's version probes run the command alone: the agent must not depend on arguments.
    const result = spawnSync(launcher, ["a b", "c'd", ""], { encoding: "utf8" });
    expect(JSON.parse(result.stdout)).toEqual({ args: ["a b", "c'd", ""], electron: "1", agent: "codex" });
  });
});

describe("wrapper and the plugin's sandbox operations", () => {
  const appTemplate = { id: "abc123def456", repository: "docker.io/library/app", tag: "v2" };

  function setFakeState(state: object) {
    writeFileSync(join(root, "sbx-state.json"), JSON.stringify(state));
  }

  it("creates a sandbox without a template only with consent to download sbx's kit image", () => {
    const ensure = (overrides: Partial<SandboxSpec>) =>
      run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(spec(overrides)) } });
    const refused = ensure({ allowImageDownloads: false });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("can download sbx's claude kit image from Docker Hub");
    expect(refused.calls.some((call) => call.args[0] === "create")).toBe(false);

    // A sandbox that exists needs no consent: nothing is created.
    expect(ensure({}).status).toBe(0);
    const existing = ensure({ allowImageDownloads: false });
    expect(existing.status).toBe(0);
    expect(existing.calls.some((call) => call.args[0] === "create")).toBe(false);
  });

  it("creates a sandbox from a template without consent: its image is local", () => {
    setFakeState({ templates: [appTemplate] });
    const result = run(["--paseo-sbx-ensure"], {
      env: { [SPEC_ENV]: JSON.stringify(spec({ template: "app:v2", allowImageDownloads: false })) },
    });
    expect(result.status).toBe(0);
    expect(result.calls.find((call) => call.args[0] === "create")?.args).toEqual(
      expect.arrayContaining(["-t", "app:v2", "--pull", "never"]),
    );
  });

  it("creates the sandbox from the repository's template and records what it used", () => {
    setFakeState({ templates: [appTemplate] });
    const sandbox = spec({ template: "app:v2" });
    const result = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(result.status).toBe(0);
    const create = result.calls.find((call) => call.args[0] === "create");
    expect(create?.args).toEqual(expect.arrayContaining(["-t", "app:v2", "--pull", "never"]));
    const state = JSON.parse(readFileSync(join(sandbox.stateDir, `${sandbox.name}.json`), "utf8"));
    expect(state).toMatchObject({
      repoKey: sandbox.repoKey,
      template: "app:v2",
      templateImageId: appTemplate.id,
      claudeConfigDir: sandbox.claudeConfigDir,
      // The configured mounts it got: the missing one was skipped.
      mounts: [`${home}:ro`],
    });
  });

  it("sizes the VM's Docker disk at creation only, and records the resources it used", () => {
    const sandbox = spec({ cpus: 4, dockerDisk: "60g" });
    const result = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(result.status).toBe(0);
    const sized = result.calls.filter((call) => call.dockerSize !== undefined);
    expect(sized.map((call) => [call.args[0], call.dockerSize])).toEqual([["create", "60g"]]);
    expect(result.calls.find((call) => call.args[0] === "create")?.args).toEqual(expect.arrayContaining(["--cpus", "4"]));
    const state = JSON.parse(readFileSync(join(sandbox.stateDir, `${sandbox.name}.json`), "utf8"));
    expect(state).toMatchObject({ memory: "3072m", cpus: 4, dockerDisk: "60g" });
  });

  it("mounts into the guest's home at every launch", () => {
    const target = join(home, ".gsd-path");
    const sandbox = spec({ homeMounts: [{ name: ".gsd-path", target }] });
    const result = run(["--model", "m"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(result.status).toBe(0);
    const helpers = result.calls.find((call) => call.args[0] === "exec" && call.args[2] === "sh");
    expect(helpers?.args.slice(-2)).toEqual([".gsd-path", target]);
    expect(helpers?.args[4]).toContain('sh "$dir/home-mounts.sh" "$@"');
  });

  it("creates the sandbox with the kit that built its template", () => {
    setFakeState({ templates: [{ id: "c0dec0dec0de", repository: "docker.io/docker/sandbox-templates", tag: "codex-docker", flavor: "codex-docker" }] });
    const sandbox = spec({ template: "docker.io/docker/sandbox-templates:codex-docker" });
    const result = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(result.status).toBe(0);
    const create = result.calls.find((call) => call.args[0] === "create");
    expect(create?.args[create.args.indexOf("never") + 1]).toBe("codex");
  });

  it("refuses a template the Paseo instance does not have, before creating anything", () => {
    setFakeState({ templates: [appTemplate] });
    const result = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(spec({ template: "app:v9" })) } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("template app:v9 is not in the Paseo sbx instance");
    expect(result.calls.some((call) => call.args[0] === "create")).toBe(false);
  });

  it("refuses to launch while a live recreation holds the sandbox", () => {
    const sandbox = spec();
    mkdirSync(sandbox.locksDir, { recursive: true });
    const marker = { pid: process.pid, start: processStart(process.pid), token: "server-token", phase: "creating" };
    writeFileSync(join(sandbox.locksDir, `${sandbox.name}.recreating`), JSON.stringify(marker));
    const result = run([], { env: { [SPEC_ENV]: JSON.stringify(sandbox) }, input: "{}\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is being recreated");
    expect(result.calls).toEqual([]);
  });

  it("drops the marker of a recreation whose owner died and creates the sandbox", () => {
    const sandbox = spec();
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    mkdirSync(sandbox.locksDir, { recursive: true });
    const markerFile = join(sandbox.locksDir, `${sandbox.name}.recreating`);
    writeFileSync(markerFile, JSON.stringify({ pid: Number(dead.stdout), start: "1", token: "t", phase: "removing" }));
    const result = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(result.status).toBe(0);
    expect(existsSync(markerFile)).toBe(false);
    expect(result.calls.some((call) => call.args[0] === "create")).toBe(true);
  });

  it("works inside a lock the server holds when given its token", () => {
    const sandbox = spec();
    const lockDir = join(sandbox.locksDir, sandbox.name);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner"), `${process.pid} server-token`);
    writeFileSync(
      join(sandbox.locksDir, `${sandbox.name}.recreating`),
      JSON.stringify({ pid: process.pid, start: processStart(process.pid), token: "server-token", phase: "creating" }),
    );
    const started = Date.now();
    const result = run(["--paseo-sbx-ensure"], {
      env: { [SPEC_ENV]: JSON.stringify(sandbox), PASEO_SBX_LOCK_TOKEN: "server-token" },
    });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    // The holder releases its own lock.
    expect(existsSync(lockDir)).toBe(true);
  });

  it("reports a failure inside the server's lock at once instead of waiting for that lock", () => {
    const sandbox = spec();
    const lockDir = join(sandbox.locksDir, sandbox.name);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner"), `${process.pid} server-token`);
    const started = Date.now();
    const result = run(["--paseo-sbx-ensure"], {
      env: { [SPEC_ENV]: JSON.stringify(sandbox), PASEO_SBX_LOCK_TOKEN: "server-token", FAKE_SBX_FAIL_CREATE: "1" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("create refused");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("leases the sandbox for as long as a session runs", async () => {
    const session = startSession({ PASEO_AGENT_ID: "agent-7" });
    await waitForGuest();
    const leasesDir = join(spec().locksDir, `${spec().name}.leases`);
    const lease = JSON.parse(readFileSync(join(leasesDir, String(session.pid)), "utf8"));
    expect(lease).toMatchObject({ pid: session.pid, agentId: "agent-7" });
    expect(lease.start).toBe(processStart(session.pid ?? 0));
    session.kill("SIGTERM");
    await exited(session);
    expect(readdirSync(leasesDir)).toEqual([]);
  });
});

describe("publications", () => {
  function fakeState(): { ports?: Record<string, { host_ip: string; host_port: number; sandbox_port: number }[]> } {
    return JSON.parse(readFileSync(join(root, "sbx-state.json"), "utf8"));
  }

  function sandboxState(sandbox: SandboxSpec) {
    return JSON.parse(readFileSync(join(sandbox.stateDir, `${sandbox.name}.json`), "utf8"));
  }

  it("publishes the repository's auto-published ports through relays and tells the guest agent", () => {
    const sandbox = spec({ autoPublish: [5173] });
    const result = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(result.status).toBe(0);
    // An explicit host port, even on loopback: sbx cannot unpublish an ephemeral one for good.
    const [publication] = sandboxState(sandbox).publications;
    expect(publication).toMatchObject({ guestPort: 5173, relayPort: 41173, allInterfaces: false, reserved: false, auto: true });
    expect(publication.hostPort).toBeGreaterThan(0);
    expect(fakeState().ports?.[sandbox.name]).toEqual([
      { host_ip: "127.0.0.1", host_port: publication.hostPort, sandbox_port: 41173, protocol: "tcp4" },
    ]);
    const control = JSON.parse(readFileSync(join(sandbox.claudeConfigDir, ".paseo-sbx", "relays.json"), "utf8"));
    expect(control.relays).toEqual([{ relayPort: 41173, guestPort: 5173 }]);
    // Ensure mode starts the relays when there are publications.
    expect(result.calls.some((call) => call.args[0] === "exec")).toBe(true);
  });

  it("accepts a binding sbx restored between listing and publishing", () => {
    const sandbox = spec({ autoPublish: [5173] });
    const result = run(["--paseo-sbx-ensure"], {
      env: { [SPEC_ENV]: JSON.stringify(sandbox), FAKE_SBX_ALREADY_PUBLISHED: "1" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("could not publish");
  });

  it("unpublishes a port that left the repository's auto-publish list", () => {
    const sandbox = spec({ autoPublish: [5173] });
    run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    const result = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify({ ...sandbox, autoPublish: [] }) } });
    expect(result.status).toBe(0);
    expect(fakeState().ports?.[sandbox.name]).toEqual([]);
    expect(sandboxState(sandbox).publications).toEqual([]);
    expect(result.calls.some((call) => call.args[0] === "exec")).toBe(false);
  });

  it("gives an every-address publication a fixed host port, and keeps the session when a port is taken", () => {
    const sandbox = spec();
    run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    const state = sandboxState(sandbox);
    state.publications = [
      { guestPort: 3000, relayPort: 41000, hostPort: null, allInterfaces: true, reserved: false },
      { guestPort: 8080, relayPort: 41080, hostPort: 18080, allInterfaces: false, reserved: true },
    ];
    writeFileSync(join(sandbox.stateDir, `${sandbox.name}.json`), JSON.stringify(state));
    const result = run([], { env: { [SPEC_ENV]: JSON.stringify(sandbox), FAKE_SBX_TAKEN_PORTS: "18080" }, input: "{}\n" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not publish guest port 8080");
    const everyAddress = sandboxState(sandbox).publications[0];
    expect(everyAddress.hostPort).toBeGreaterThan(0);
    expect(fakeState().ports?.[sandbox.name]).toEqual([
      { host_ip: "0.0.0.0", host_port: everyAddress.hostPort, sandbox_port: 41000, protocol: "tcp4" },
    ]);
  });
});

// Descendants of the fake claude that run `sleep 300`, with their shells.
async function waitForTools(): Promise<number[]> {
  return waitFor(() => {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((row) => row.length >= 3);
    const claude = rows.find((row) => row.slice(2).join(" ").includes(`${bin}/claude`) && !row.join(" ").includes("guest-supervisor"));
    if (!claude) return null;
    const tree: number[] = [];
    const pending = [claude[0]];
    while (pending.length > 0) {
      const parent = pending.pop();
      for (const row of rows.filter((candidate) => candidate[1] === parent)) {
        tree.push(Number(row[0]));
        pending.push(row[0]);
      }
    }
    const hasSleep = rows.some((row) => tree.includes(Number(row[0])) && row[2] === "sleep");
    return hasSleep ? tree : null;
  });
}


describe("Codex sessions", () => {
  function codexSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
    const homesDir = join(root, "state", "homes");
    return spec({
      agent: "codex",
      binary: "codex",
      kit: "codex",
      agentHome: { env: "CODEX_HOME", path: join(homesDir, "codex") },
      homesDir,
      mounts: [homesDir],
      ...overrides,
    });
  }

  it("runs the template's codex with the shared home in the agent's cwd", () => {
    const sandbox = codexSpec();
    const result = run(["app-server"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) }, input: '{"id":1,"method":"initialize"}\n' });
    expect(result.status).toBe(0);
    const exec = result.calls.find((call) => call.args[0] === "exec" && call.args[1] === "-i");
    expect(exec?.args).toEqual(expect.arrayContaining(["-w", workspace, sandbox.name, "codex", "app-server"]));
    const guest = JSON.parse(result.stdout);
    expect(guest.env.CODEX_HOME).toBe(join(root, "state", "homes", "codex"));
    expect(guest.input).toBe('{"id":1,"method":"initialize"}');
    const state = JSON.parse(readFileSync(join(sandbox.stateDir, `${sandbox.name}.json`), "utf8"));
    expect(state.mounts).toContain(sandbox.homesDir);
  });

  it("copies prompt images into the sandbox's config dir and points the message there", () => {
    const sandbox = codexSpec();
    const image = join(root, "host-tmp", "prompt.png");
    mkdirSync(dirname(image), { recursive: true });
    writeFileSync(image, "png-bytes");
    const turn = { id: 2, method: "turn/start", params: { input: [{ type: "text", text: "hi" }, { type: "localImage", path: image }] } };
    const result = run(["app-server"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) }, input: `${JSON.stringify(turn)}\n` });
    expect(result.status).toBe(0);
    const forwarded = JSON.parse(JSON.parse(result.stdout).input);
    const copied = forwarded.params.input[1].path as string;
    expect(copied.startsWith(join(sandbox.claudeConfigDir, ".paseo-sbx", "images"))).toBe(true);
    expect(readFileSync(copied, "utf8")).toBe("png-bytes");
    expect(forwarded.params.input[0]).toEqual({ type: "text", text: "hi" });
  });

  it("passes a line it cannot rewrite through unchanged", () => {
    const sandbox = codexSpec();
    const line = '{"id":3,"params":{"type":"localImage","path":"/nonexistent.png"}}';
    const result = run(["app-server"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) }, input: `${line}\n` });
    expect(JSON.parse(result.stdout).input).toBe(line);
    expect(result.stderr).toContain("passing a prompt image through unchanged");
  });

  it("asks to recreate a sandbox created before agents shared homes", () => {
    const sandbox = codexSpec();
    writeFileSync(join(root, "sbx-state.json"), JSON.stringify({ sandboxes: [sandbox.name] }));
    mkdirSync(sandbox.stateDir, { recursive: true });
    writeFileSync(join(sandbox.stateDir, `${sandbox.name}.json`), JSON.stringify({ mounts: [`${home}:ro`], policies: [] }));
    const result = run(["app-server"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("predates shared agent homes");
  });
});

describe("MCP servers", () => {
  const GATEWAY_URL = "http://mcp-gateway.docker.internal/mcp";
  const GATEWAY = { type: "http", url: GATEWAY_URL, headers: { Authorization: "Bearer proxy-managed" } };

  function register(names: string[], extra: Record<string, unknown> = {}) {
    const mcp = Object.fromEntries(names.map((name) => [name, { url: `https://${name}.example/mcp`, headers: [], oauth: false }]));
    writeFileSync(join(root, "sbx-state.json"), JSON.stringify({ mcp, ...extra }));
  }
  const gatewayFile = (sandbox: SandboxSpec) =>
    join(sandbox.stateHome, "sandboxes", "sandboxes", "sandboxd", "mcp", "gateways", `${sandbox.name}.json`);
  const loaded = (sandbox: SandboxSpec) => JSON.parse(readFileSync(gatewayFile(sandbox), "utf8")).dynamic_added_set;
  const state = (sandbox: SandboxSpec) => JSON.parse(readFileSync(join(sandbox.stateDir, `${sandbox.name}.json`), "utf8"));
  const mcpCalls = (result: Run) => result.calls.filter((call) => call.args[0] === "mcp").map((call) => call.args.join(" "));

  it("loads the repository's servers at launch and unloads the ones turned off since", () => {
    register(["docs", "search"]);
    const sandbox = spec({ mcpServers: ["docs", "search"] });
    const first = run(["--model", "m"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(first.status).toBe(0);
    expect(loaded(sandbox)).toEqual(["docs", "search"]);
    expect(state(sandbox)).toEqual(expect.objectContaining({ mcpAutoLoad: ["docs", "search"], mcpUnload: [], mcpErrors: {} }));

    const again = run(["--model", "m"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(mcpCalls(again)).toEqual([]);

    const fewer = run(["--model", "m"], { env: { [SPEC_ENV]: JSON.stringify(spec({ mcpServers: ["docs"] })) } });
    expect(mcpCalls(fewer)).toEqual([`mcp unload search --sandbox ${sandbox.name}`]);
    expect(loaded(sandbox)).toEqual(["docs"]);
  });

  it("keeps unloads waiting while a prepared sandbox is stopped, and never fails a launch over MCP", () => {
    const sandbox = spec({ mcpServers: ["broken"] });
    register(["docs", "broken"], { sandboxes: [sandbox.name], stopped: [sandbox.name] });
    mkdirSync(dirname(gatewayFile(sandbox)), { recursive: true });
    writeFileSync(gatewayFile(sandbox), JSON.stringify({ runtime_id: sandbox.name, dynamic_added_set: ["docs"] }));
    mkdirSync(sandbox.stateDir, { recursive: true });
    writeFileSync(join(sandbox.stateDir, `${sandbox.name}.json`), JSON.stringify({ mcpAutoLoad: ["docs"] }));

    const prepared = run(["--paseo-sbx-ensure"], { env: { [SPEC_ENV]: JSON.stringify(sandbox), FAKE_SBX_MCP_FAIL: "broken" } });
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain("loading MCP server broken failed");
    expect(mcpCalls(prepared)).toEqual([`mcp load broken --sandbox ${sandbox.name}`]);
    expect(state(sandbox)).toEqual(
      expect.objectContaining({ mcpUnload: ["docs"], mcpErrors: { broken: expect.stringContaining("502 Bad Gateway") } }),
    );

    // A session starts the VM: the unload goes through and the load is tried again.
    const session = run(["--model", "m"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } });
    expect(session.status).toBe(0);
    expect(loaded(sandbox)).toEqual(["broken"]);
    expect(state(sandbox)).toEqual(expect.objectContaining({ mcpAutoLoad: ["broken"], mcpUnload: [], mcpErrors: {} }));
  });

  it("gives Claude sbx's gateway, merged into Paseo's MCP config", () => {
    const sandbox = spec();
    const paseo = { type: "http", url: "http://127.0.0.1:6767/mcp/agents" };
    const env = { [SPEC_ENV]: JSON.stringify(sandbox), FAKE_SBX_GATEWAY_URL: GATEWAY_URL };
    const merged = JSON.parse(run(["--mcp-config", JSON.stringify({ mcpServers: { paseo } }), "--model", "m"], { env }).stdout);
    expect(merged.args.filter((arg: string) => arg === "--mcp-config")).toHaveLength(1);
    expect(JSON.parse(merged.args[merged.args.indexOf("--mcp-config") + 1]).mcpServers).toEqual({ paseo, "mcp-gateway": GATEWAY });
    expect(merged.args.slice(-2)).toEqual(["--model", "m"]);
    expect(merged.env.PASEO_SBX_MCP_GATEWAY).toBeUndefined();

    const alone = JSON.parse(run(["--model", "m"], { env }).stdout);
    expect(alone.args.slice(0, 3)).toEqual(["--model", "m", "--mcp-config"]);
    expect(JSON.parse(alone.args[3])).toEqual({ mcpServers: { "mcp-gateway": GATEWAY } });

    // No gateway in the VM, or an agent whose kit configures it: the arguments stay as they came.
    expect(JSON.parse(run(["--model", "m"], { env: { [SPEC_ENV]: JSON.stringify(sandbox) } }).stdout).args).toEqual(["--model", "m"]);
    const homesDir = join(root, "state", "homes");
    const codex = spec({
      name: "paseo-codex-0000abcd",
      agent: "codex",
      binary: "codex",
      kit: "codex",
      agentHome: { env: "CODEX_HOME", path: join(homesDir, "codex") },
      homesDir,
      mounts: [homesDir],
    });
    const codexRun = run(["app-server"], { env: { [SPEC_ENV]: JSON.stringify(codex), FAKE_SBX_GATEWAY_URL: GATEWAY_URL }, input: "{}\n" });
    expect(JSON.parse(codexRun.stdout).args).toEqual(["app-server"]);
  });
});

describe("Sandbox terminal", () => {
  const TITLE = "\x1b]0;Sandbox\x07";

  it("asks for the dashboard when the workspace's sandbox is not recorded yet", () => {
    const result = run(["--paseo-sbx-shell"], { env: { PASEO_WORKSPACE_ID: "wks_unknown" } });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(TITLE);
    expect(result.stderr).toContain("open its Sandbox dashboard once");
    expect(result.calls).toEqual([]);
  });

  it("creates the recorded sandbox and opens a shell in the workspace with the sessions' Claude config and login", () => {
    const hostSettings = join(root, "host-claude-settings.json");
    writeFileSync(hostSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://gateway.test:1" }, model: "x" }));
    const sandbox = spec({ env: {}, mcpServers: [], hostClaudeSettings: hostSettings });
    mkdirSync(join(root, "state", "workspaces"), { recursive: true });
    writeFileSync(join(root, "state", "workspaces", "wks_1.json"), JSON.stringify(sandbox));
    const input = 'echo "in the guest: $PWD"; echo "config: $CLAUDE_CONFIG_DIR"; echo "codex: $CODEX_HOME"; echo "base: $ANTHROPIC_BASE_URL"\n';
    const result = run(["--paseo-sbx-shell"], { env: { PASEO_WORKSPACE_ID: "wks_1" }, input });
    expect(result.status).toBe(0);
    expect(result.stdout.startsWith(TITLE)).toBe(true);
    expect(result.stdout).toContain(`in the guest: ${workspace}`);
    expect(result.stdout).toContain(`config: ${sandbox.claudeConfigDir}`);
    expect(result.stdout).toContain(`codex: ${join(sandbox.homesDir, "codex")}`);
    expect(result.stdout).toContain("base: http://gateway.test:1");
    expect(result.calls.map((call) => call.args[0])).toContain("create");
    const shell = result.calls.at(-1)?.args ?? [];
    expect(shell.slice(0, 5)).toEqual(["exec", "-it", "-w", workspace, "--env-file"]);
    expect(shell.slice(6)).toEqual([sandbox.name, "bash", "--rcfile", join(sandbox.binDir, "paseo-sbx-shellrc"), "-i"]);
  });
});
