import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPEC_ENV, type SandboxSpec } from "../shared/spec";
import { WRAPPER_SOURCE } from "../server/wrapper-source";

// A fake sbx that keeps sandboxes in a JSON file, logs every call, and runs `exec` commands
// locally with a VM-like environment: PATH plus the `-e NAME` variables only.
const FAKE_SBX = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_SBX_STATE;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { sandboxes: [] };
fs.appendFileSync(process.env.FAKE_SBX_LOG, JSON.stringify({ args, stateHome: process.env.XDG_STATE_HOME }) + '\\n');
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
if (args[0] === 'ls') {
  process.stdout.write(JSON.stringify(state.sandboxes.map((name) => ({ name, status: 'running' }))));
} else if (args[0] === 'create') {
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
    if (args[i] === '-e') { const name = args[++i]; if (process.env[name] !== undefined) env[name] = process.env[name]; continue; }
    break;
  }
  if (!state.sandboxes.includes(args[i])) { process.stderr.write('no such sandbox'); process.exit(1); }
  const result = cp.spawnSync(args[i + 1], args.slice(i + 2), { cwd, env, stdio: 'inherit' });
  process.exit(result.status === null ? 1 : result.status);
} else {
  process.exit(2);
}
`;

// A fake claude that reports what it received and echoes the first stdin line.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8').split('\\n')[0];
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env, input }));
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
  return {
    version: 1,
    name: "paseo-workspace-0000abcd",
    key: "workspace:wks_1",
    stateHome: join(state, "sbx"),
    stateDir: join(state, "sandboxes"),
    locksDir: join(state, "locks"),
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
  calls: { args: string[]; stateHome: string }[];
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

    // Secrets travel in the sbx client's environment, never on its command line.
    const exec = first.calls.find((call) => call.args[0] === "exec");
    expect(exec?.args.join(" ")).not.toContain("s3cret-value");

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
    const result = run([], { env: { [SPEC_ENV]: JSON.stringify({ ...spec(), version: 2 }) } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported PASEO_SBX_SPEC version 2");
  });
});
