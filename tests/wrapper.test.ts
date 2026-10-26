import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPEC_ENV, type SandboxSpec } from "../shared/spec";
import { SUPERVISOR_SOURCE, WRAPPER_SOURCE, launcherSource } from "../server/wrapper-source";

// A fake sbx that keeps sandboxes in a JSON file, logs every call with the names in its
// environment, and runs `exec` commands locally with a VM-like environment: PATH plus the
// `--env-file` values and the `-e NAME` variables only.
const FAKE_SBX = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_SBX_STATE;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { sandboxes: [] };
fs.appendFileSync(process.env.FAKE_SBX_LOG, JSON.stringify({ args, stateHome: process.env.XDG_STATE_HOME, envNames: Object.keys(process.env) }) + '\\n');
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
if (args[0] === 'ls') {
  if (process.env.FAKE_SBX_LS_ERROR) { process.stderr.write(process.env.FAKE_SBX_LS_ERROR); process.exit(1); }
  process.stdout.write(JSON.stringify(state.sandboxes.map((name) => ({ name, status: 'running' }))));
} else if (args[0] === 'create') {
  if (process.env.FAKE_SBX_FAIL_CREATE) { process.stderr.write('create refused'); process.exit(3); }
  state.sandboxes.push(args[args.indexOf('--name') + 1]);
  save();
} else if (args[0] === 'policy') {
  // accepted
} else if (args[0] === 'exec') {
  let i = 1;
  let cwd = process.cwd();
  const env = { PATH: process.env.PATH };
  for (; i < args.length; i++) {
    if (args[i] === '-i') continue;
    if (args[i] === '-w') { cwd = args[++i]; continue; }
    if (args[i] === '-e') { const name = args[++i]; env[name] = process.env[name] === undefined ? '' : process.env[name]; continue; }
    if (args[i] === '--env-file') {
      for (const line of fs.readFileSync(args[++i], 'utf8').split('\\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      continue;
    }
    break;
  }
  if (!state.sandboxes.includes(args[i])) { process.stderr.write('no such sandbox'); process.exit(1); }
  const guest = cp.spawn(args[i + 1], args.slice(i + 2), { cwd, env, stdio: ['pipe', 'inherit', 'inherit'], detached: true });
  if (process.env.FAKE_SBX_DETACH) {
    // Like a client that exits on stdin EOF while the guest keeps running.
    guest.stdin.end();
    guest.unref();
    process.exit(0);
  }
  // The guest's stdin is a pipe from the client: it reaches EOF when the client goes away.
  process.stdin.pipe(guest.stdin);
  guest.stdin.on('error', () => {});
  guest.on('exit', (code) => process.exit(code === null ? 1 : code));
} else {
  process.exit(2);
}
`;

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
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "sbx"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);
  wrapper = join(root, "paseo-sbx-claude.cjs");
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
    version: 2,
    name: "paseo-workspace-0000abcd",
    key: "workspace:wks_1",
    stateHome: join(state, "sbx"),
    stateDir: join(state, "sandboxes"),
    locksDir: join(state, "locks"),
    runDir: join(state, "run"),
    binDir: join(state, "bin"),
    workspace,
    mounts: [join(root, "missing-mount"), `${home}:ro`],
    memory: "3072m",
    cpus: 0,
    networkAllow: ["**"],
    forwardPorts: [],
    env: { LICENSE_KEY: "s3cret-value" },
    claudeConfigDir: join(state, "claude", "paseo-workspace-0000abcd"),
    ...overrides,
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: { args: string[]; stateHome: string; envNames: string[] }[];
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

describe("wrapper", () => {
  it("runs Paseo's catalogue probe on the host without touching sbx", () => {
    const result = run(PROBE_ARGS, { cwd: home, input: "hello\n" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
    expect(JSON.parse(result.stdout).args).toEqual(PROBE_ARGS);
  });

  it("answers version and login queries on the host without a spec", () => {
    for (const query of [["--version"], ["auth", "status"]]) {
      const result = run(query, { cwd: workspace });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
      expect(JSON.parse(result.stdout).args).toEqual(query);
    }
  });

  it("fails closed for a session without a spec", () => {
    const result = run(["--output-format", "stream-json"], { cwd: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("claude-sbx sessions need the paseo-sbx plugin enabled");
    expect(result.calls).toEqual([]);
  });

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
      `${bin}:ro`,
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
    const exec = first.calls.find((call) => call.args[0] === "exec");
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
      ["rm", "network", "--sandbox", spec().name, "--resource", "**"],
    ]);
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
    const exec = result.calls.find((call) => call.args[0] === "exec");
    expect(exec?.args).toEqual(expect.arrayContaining(["-e", "PEM"]));
    expect(exec?.envNames).not.toContain("SPECIAL");
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

  it("launches the wrapper through the shell launcher with arguments intact", () => {
    const dir = join(root, "it's a dir");
    mkdirSync(dir);
    const script = join(dir, "echo-args.cjs");
    writeFileSync(script, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE }));");
    const launcher = join(dir, "launcher");
    writeFileSync(launcher, launcherSource(process.execPath, script));
    chmodSync(launcher, 0o755);
    const result = spawnSync(launcher, ["a b", "c'd", ""], { encoding: "utf8" });
    expect(JSON.parse(result.stdout)).toEqual({ args: ["a b", "c'd", ""], electron: "1" });
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

