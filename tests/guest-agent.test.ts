import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUEST_AGENT_SOURCE } from "../server/wrapper-source";

let root: string;
let agent: ChildProcess | null = null;
let service: Server | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-agent-"));
});

afterEach(async () => {
  agent?.kill("SIGKILL");
  agent = null;
  await new Promise<void>((resolve) => (service ? service.close(() => resolve()) : resolve()));
  service = null;
  rmSync(root, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitFor<T>(probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A fresh connection per request: a pooled one would outlive the relay it went through. */
function get(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const request = httpGet({ host: "127.0.0.1", port, path: "/", agent: false, headers: { Connection: "close" }, timeout: 1000 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? null);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

describe("guest agent", () => {
  it("relays a loopback-only service on its relay port and reports listening ports", async () => {
    const state = join(root, "state");
    mkdirSync(state);
    const [servicePort, relayPort, internalPort] = await Promise.all([freePort(), freePort(), freePort()]);
    service = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => service?.listen(servicePort, "127.0.0.1", resolve));
    writeFileSync(join(state, "relays.json"), JSON.stringify({ relays: [{ relayPort, guestPort: servicePort }], internal: [internalPort] }));
    const script = join(root, "guest-agent.py");
    writeFileSync(script, GUEST_AGENT_SOURCE);
    agent = spawn("python3", [script, state], {
      env: { ...process.env, PASEO_SBX_AGENT_PID: join(root, "agent.pid") },
      stdio: "ignore",
    });

    expect(await waitFor(async () => (await get(relayPort)) === 200)).toBe(true);
    const snapshot = await waitFor(() => {
      if (!existsSync(join(state, "listeners.json"))) return null;
      return JSON.parse(readFileSync(join(state, "listeners.json"), "utf8")) as { listeners: { port: number; addresses: string[] }[] };
    });
    const ports = snapshot.listeners.map((listener) => listener.port);
    expect(snapshot.listeners.find((listener) => listener.port === servicePort)?.addresses).toContain("127.0.0.1");
    // Its own relay ports and the plugin's internal ports are not services.
    expect(ports).not.toContain(relayPort);
    expect(Number(readFileSync(join(root, "agent.pid"), "utf8"))).toBe(agent.pid);

    writeFileSync(join(state, "relays.json"), JSON.stringify({ relays: [], internal: [] }));
    expect(await waitFor(async () => (await get(relayPort)) === null)).toBe(true);
  }, 30_000);
});
