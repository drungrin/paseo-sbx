import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandboxHolds, type SandboxHolds } from "../server/holds";
import { pluginPaths, type PluginPaths } from "../server/paths";
import { installFakeSbx, type FakeSbx } from "./fake-sbx";

const NAME = "paseo-app-0123abcd";

let root: string;
let paths: PluginPaths;
let fake: FakeSbx;
let holds: SandboxHolds | null;
let clock: number;
let hours: number;
let active: boolean | null;
const savedEnv = { ...process.env };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-sbx-holds-")));
  fake = installFakeSbx(root);
  Object.assign(process.env, fake.env);
  paths = pluginPaths({ XDG_STATE_HOME: join(root, "state") }, join(root, "home"));
  fake.setState({ sandboxes: [NAME] });
  clock = 0;
  hours = 0;
  active = true;
  holds = null;
});

afterEach(() => {
  holds?.dispose();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

function create(): SandboxHolds {
  holds = createSandboxHolds(paths, {
    maxIdleHours: async () => hours,
    hasActiveAgents: async () => active,
    now: () => clock,
  });
  return holds;
}

const holdExecs = () => fake.calls().filter((call) => call.args[0] === "exec" && call.args.includes("-i"));

/** Holds through a client the test can see, like the plugin's. */
function createWithClients(clients: ChildProcess[]): SandboxHolds {
  holds = createSandboxHolds(paths, {
    maxIdleHours: async () => 0,
    hasActiveAgents: async () => true,
    spawnHold: (name) => {
      const child = spawn("sbx", ["exec", "-i", name, "sh", "-c", "echo paseo-sbx-hold; exec cat >/dev/null"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      clients.push(child);
      return child;
    },
  });
  return holds;
}

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) resolve();
      else if (Date.now() > deadline) reject(new Error("timed out"));
      else setTimeout(poll, 50);
    };
    poll();
  });
}

describe("sandbox holds", () => {
  it("holds a running VM with one exec that waits on its stdin, and releases it", async () => {
    const holds = create();
    await holds.activity(NAME);
    await holds.activity(NAME);
    expect(holds.held()).toEqual([NAME]);
    expect(holdExecs()).toHaveLength(1);
    expect(holdExecs()[0].args).toEqual(["exec", "-i", NAME, "sh", "-c", "echo paseo-sbx-hold; exec cat >/dev/null"]);
    holds.release(NAME);
    expect(holds.held()).toEqual([]);
  });

  it("never starts a stopped VM, nor holds one whose agents are all archived", async () => {
    fake.setState({ sandboxes: [NAME], stopped: [NAME] });
    const holds = create();
    await holds.activity(NAME);
    expect(holds.held()).toEqual([]);
    expect(fake.calls().some((call) => call.args[0] === "exec")).toBe(false);

    fake.setState({ sandboxes: [NAME] });
    active = false;
    await holds.activity(NAME);
    expect(holds.held()).toEqual([]);
    expect(fake.calls().some((call) => call.args[0] === "exec")).toBe(false);
  });

  it("forgets a hold whose VM was stopped under it, and holds it again at the next turn", async () => {
    const clients: ChildProcess[] = [];
    const holds = createWithClients(clients);
    await holds.activity(NAME);
    expect(holds.held()).toEqual([NAME]);
    clients[0].kill("SIGKILL");
    await waitFor(() => holds.held().length === 0);
    await holds.activity(NAME);
    expect(holds.held()).toEqual([NAME]);
    expect(clients).toHaveLength(2);
  });

  it("releases a hold past the idle limit, or once its agents are archived; 0 hours keeps it", async () => {
    const holds = create();
    await holds.activity(NAME);
    clock = 100 * 3_600_000;
    await holds.sweep();
    expect(holds.held()).toEqual([NAME]);

    hours = 2;
    clock = 0;
    await holds.activity(NAME);
    clock = 3_600_000;
    await holds.sweep();
    expect(holds.held()).toEqual([NAME]);
    clock = 2 * 3_600_000;
    await holds.sweep();
    expect(holds.held()).toEqual([]);

    hours = 0;
    await holds.activity(NAME);
    expect(holds.held()).toEqual([NAME]);
    active = null;
    await holds.sweep();
    expect(holds.held()).toEqual([NAME]);
    active = false;
    await holds.sweep();
    expect(holds.held()).toEqual([]);
  });

  it("ends the guest side when released, through its stdin", async () => {
    const clients: ChildProcess[] = [];
    const holds = createWithClients(clients);
    await holds.activity(NAME);
    expect(clients[0].exitCode).toBe(null);
    holds.dispose();
    // Its stdin's EOF ends the guest's cat, and with it the client.
    await waitFor(() => clients[0].exitCode !== null);
    expect(clients[0].exitCode).toBe(0);
  });
});
