import { spawn, type ChildProcess } from "node:child_process";
import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { activeAgentsBySandbox } from "./agents";
import { readBinding } from "./bindings";
import type { ServerDeps } from "./hooks";
import { newLockToken, withSandboxLock } from "./lock";
import type { PluginPaths } from "./paths";
import { runSbxOk, sbxEnv } from "./sbx";

/**
 * Keeps a VM running while agents bound to it are not archived. sbx stops a VM 30 s after its
 * last `sbx exec`, and Paseo closes an idle agent's runtime after an hour (its idle runtime
 * cleanup), ending the session's exec. On the host that close leaves an agent's detached work
 * running; in a VM it took the whole VM down with it. A hold is one more exec, which waits on its
 * stdin: ending that stdin, or the plugin's process going away, ends it in the guest too.
 */
export interface HoldOptions {
  /** Hours a hold outlives the last turn of its sandbox's agents; 0 keeps it until they are archived. */
  maxIdleHours(): Promise<number>;
  /** Whether agents bound to the sandbox are not archived; null when unknown. */
  hasActiveAgents(name: string): Promise<boolean | null>;
  now?: () => number;
  /** Starts the guest side of a hold; tests replace it. */
  spawnHold?: (name: string) => ChildProcess;
  /** How long the guest has to report the hold before it is given up. */
  readyTimeoutMs?: number;
}

interface Hold {
  child: ChildProcess;
  lastActivity: number;
}

const READY = "paseo-sbx-hold";

// The guest reports itself, then waits on its stdin: EOF, however the client ends, ends it.
const GUEST_HOLD = `echo ${READY}; exec cat >/dev/null`;

export interface SandboxHolds {
  /** A turn of an agent bound to `name`: holds its VM when it runs, and restarts its idle clock. */
  activity(name: string): Promise<void>;
  /** Releases the hold of `name`. */
  release(name: string): void;
  /** Releases holds idle for longer than the limit, and those whose agents are all archived. */
  sweep(): Promise<void>;
  held(): string[];
  dispose(): void;
}

export function createSandboxHolds(paths: PluginPaths, options: HoldOptions): SandboxHolds {
  const now = options.now ?? Date.now;
  const spawnHold =
    options.spawnHold ??
    ((name: string) =>
      spawn("sbx", ["exec", "-i", name, "sh", "-c", GUEST_HOLD], {
        env: sbxEnv(paths),
        stdio: ["pipe", "pipe", "ignore"],
      }));
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const holds = new Map<string, Hold>();
  const acquiring = new Map<string, Promise<void>>();

  function end(child: ChildProcess): void {
    child.stdin?.end();
    // A client that does not exit on its stdin's EOF is stopped.
    const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }

  function waitReady(child: ChildProcess): Promise<boolean> {
    return new Promise((resolve) => {
      let output = "";
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onExit);
        resolve(ready);
      };
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(READY)) finish(true);
      };
      const onExit = () => finish(false);
      const timer = setTimeout(() => finish(false), readyTimeoutMs);
      child.stdout?.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onExit);
    });
  }

  async function running(name: string): Promise<boolean> {
    const entries = JSON.parse((await runSbxOk(paths, ["ls", "--json"], "sbx ls")) || "[]") as {
      name: string;
      status?: string;
    }[];
    return entries.some((entry) => entry.name === name && entry.status === "running");
  }

  // Under the sandbox lock, so a Stop, a template save or a recreation never races it: a hold
  // starts only on a running VM, and is in the guest before the lock is released. An exec on a
  // stopped VM would start it.
  async function acquire(name: string): Promise<void> {
    if ((await options.hasActiveAgents(name)) === false) return;
    await withSandboxLock(paths, name, newLockToken(), async () => {
      if (holds.has(name) || !(await running(name))) return;
      const child = spawnHold(name);
      child.on("error", () => {});
      child.stdin?.on("error", () => {});
      child.once("exit", () => {
        if (holds.get(name)?.child === child) holds.delete(name);
      });
      if (!(await waitReady(child))) {
        end(child);
        console.warn(`[paseo-sbx] ${name}: could not hold the VM for its idle agents`);
        return;
      }
      child.stdout?.resume();
      holds.set(name, { child, lastActivity: now() });
    });
  }

  return {
    async activity(name) {
      const hold = holds.get(name);
      if (hold) {
        hold.lastActivity = now();
        return;
      }
      let pending = acquiring.get(name);
      if (!pending) {
        pending = acquire(name).finally(() => acquiring.delete(name));
        acquiring.set(name, pending);
      }
      await pending;
    },
    release(name) {
      const hold = holds.get(name);
      if (!hold) return;
      holds.delete(name);
      end(hold.child);
    },
    async sweep() {
      const hours = await options.maxIdleHours();
      const limit = hours > 0 ? hours * 3_600_000 : Infinity;
      for (const [name, hold] of [...holds]) {
        // An archive whose event was missed, or that raced a turn's end, releases it here.
        const idle = now() - hold.lastActivity >= limit || (await options.hasActiveAgents(name)) === false;
        if (!idle || holds.get(name) !== hold) continue;
        holds.delete(name);
        end(hold.child);
      }
    },
    held: () => [...holds.keys()],
    dispose() {
      for (const hold of holds.values()) end(hold.child);
      holds.clear();
    },
  };
}

/**
 * Holds follow the agents' turns: the start or end of a turn of a sandboxed agent holds its VM
 * (once it runs) and restarts the idle clock; archiving the last agent of a sandbox releases it.
 * A plugin restart drops the holds until the next turn.
 */
export function registerHolds(server: PluginServerContext, deps: Pick<ServerDeps, "paths" | "readSettings">): () => void {
  // The API of the latest hook, for the sweep, which runs outside any.
  let paseo: PluginHookContext["paseo"] | null = null;
  const holds = createSandboxHolds(deps.paths, {
    maxIdleHours: async () => (await deps.readSettings()).idleHoldHours,
    hasActiveAgents: async (name) => (paseo ? ((await activeAgentsBySandbox(deps.paths, paseo)).get(name) ?? []).length > 0 : null),
  });
  const warn = (name: string) => (error: unknown) =>
    console.warn(`[paseo-sbx] ${name}: holding the VM: ${error instanceof Error ? error.message : error}`);
  const onTurn = ({ agent }: { agent: { id: string } }, context: PluginHookContext) => {
    paseo = context.paseo;
    const name = readBinding(deps.paths, agent.id)?.name;
    if (name) void holds.activity(name).catch(warn(name));
  };
  const unsubscribe = [
    server.on("agent.turn_started", onTurn),
    server.on("agent.turn_ended", onTurn),
    server.on("agent.archived", async ({ agent }, context) => {
      paseo = context.paseo;
      const name = readBinding(deps.paths, agent.id)?.name;
      if (!name || !holds.held().includes(name)) return;
      const others = ((await activeAgentsBySandbox(deps.paths, context.paseo)).get(name) ?? []).filter(({ id }) => id !== agent.id);
      if (others.length === 0) holds.release(name);
    }),
  ];
  const timer = setInterval(() => {
    void holds.sweep().catch((error: unknown) => console.warn(`[paseo-sbx] releasing idle VMs: ${error instanceof Error ? error.message : error}`));
  }, 60_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const off of unsubscribe) off();
    holds.dispose();
  };
}
