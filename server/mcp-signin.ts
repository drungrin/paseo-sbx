import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { get } from "node:http";
import { MCP_NAME_PATTERN } from "../shared/mcp";
import type { SignInView } from "../shared/rpc";
import type { PluginPaths } from "./paths";
import { sbxEnv } from "./sbx";

/**
 * OAuth sign-ins for MCP servers, run by `sbx mcp auth`. Without a display, sbx prints the
 * authorization page and waits on a loopback listener for the provider's redirect. A browser on
 * another device lands on an address that fails to load there; you paste it back and the plugin
 * delivers it to sbx's listener on this host. The tokens stay with sbx.
 */

const URL_LINE = /Open this URL to authorize MCP server "[^"]*":\s*(https?:\/\/\S+)/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const URL_WAIT_MS = 20_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const FORGET_AFTER_MS = 10 * 60_000;

export interface Callback {
  port: number;
  path: string;
  state: string;
}

/** The authorization page sbx printed, and where it expects the provider to send the browser back. */
export function parseAuthorizationUrl(output: string): { url: string; callback: Callback | null } | null {
  const match = URL_LINE.exec(output);
  if (!match) return null;
  let url: URL;
  try {
    url = new URL(match[1]);
  } catch {
    return null;
  }
  const redirect = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  let back: URL | null = null;
  try {
    back = redirect ? new URL(redirect) : null;
  } catch {
    back = null;
  }
  // A redirect elsewhere (a hosted gateway) completes without the plugin.
  if (!back || !state || back.protocol !== "http:" || !LOOPBACK.has(back.hostname) || !back.port) {
    return { url: match[1], callback: null };
  }
  return { url: match[1], callback: { port: Number(back.port), path: back.pathname, state } };
}

/**
 * The address on this host to deliver a pasted redirect to. Only this sign-in's redirect passes:
 * the same loopback port, path and `state`, so a paste never makes the plugin request anything
 * else, and a stale one cannot end the sign-in (sbx aborts on a wrong `state`).
 */
export function callbackTarget(expected: Callback, pasted: string): string {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new Error("Paste the whole address from the browser's address bar, starting with http://");
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK.has(url.hostname) ||
    Number(url.port) !== expected.port ||
    url.pathname !== expected.path
  ) {
    throw new Error(`That is not this sign-in's address: it starts with http://127.0.0.1:${expected.port}${expected.path}`);
  }
  if (url.searchParams.get("state") !== expected.state) {
    throw new Error("That address is from another sign-in: copy the one the browser shows after opening this link");
  }
  if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
    throw new Error("That address has no authorization code yet: copy it once the provider sends the browser back");
  }
  return `http://127.0.0.1:${expected.port}${url.pathname}${url.search}`;
}

/** sbx's error lines, without the authorization page. */
function failureMessage(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^https?:\/\//.test(line));
  const errors = lines.filter((line) => line.startsWith("error:")).map((line) => line.slice(6).trim());
  return errors.join("; ") || lines.at(-1) || "sbx ended the sign-in";
}

interface Flow {
  view: SignInView;
  child: ChildProcess | null;
  output: string;
  callback: Callback | null;
  ended: Promise<void>;
}

const flows = new Map<string, Flow>();

function settle(flow: Flow, status: SignInView["status"], error: string | null): void {
  if (flow.view.status !== "waiting") return;
  flow.view = { ...flow.view, status, error };
  flow.child = null;
  setTimeout(() => flows.delete(flow.view.id), FORGET_AFTER_MS).unref();
}

function stop(flow: Flow, status: "failed" | "cancelled", error: string | null): void {
  const child = flow.child;
  settle(flow, status, error);
  child?.kill("SIGTERM");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * Starts `sbx mcp auth <server>` and returns once it prints the authorization page. On a host with
 * a display sbx may open a browser there instead: the view then has no URL and ends on its own.
 */
export async function startSignIn(paths: PluginPaths, server: string): Promise<SignInView> {
  if (!MCP_NAME_PATTERN.test(server)) throw new Error(`not an MCP server name: ${server}`);
  for (const flow of flows.values()) {
    if (flow.view.server === server && flow.view.status === "waiting") stop(flow, "cancelled", null);
  }
  const id = randomUUID();
  const child = spawn("sbx", ["mcp", "auth", server], { env: sbxEnv(paths), stdio: ["ignore", "pipe", "pipe"] });
  let shown: () => void = () => {};
  const urlShown = new Promise<void>((resolve) => {
    shown = resolve;
  });
  let ended: () => void = () => {};
  const flow: Flow = {
    view: { id, server, url: null, callbackOrigin: null, status: "waiting", error: null },
    child,
    output: "",
    callback: null,
    ended: new Promise<void>((resolve) => {
      ended = resolve;
    }),
  };
  flows.set(id, flow);
  const collect = (chunk: Buffer) => {
    flow.output += chunk.toString();
    if (flow.view.url) return;
    const found = parseAuthorizationUrl(flow.output);
    if (!found) return;
    flow.callback = found.callback;
    flow.view = {
      ...flow.view,
      url: found.url,
      callbackOrigin: found.callback ? `http://127.0.0.1:${found.callback.port}` : null,
    };
    shown();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => {
    settle(flow, "failed", `sbx mcp auth: ${error.message}`);
    shown();
    ended();
  });
  child.on("exit", (code) => {
    settle(flow, code === 0 ? "done" : "failed", code === 0 ? null : failureMessage(flow.output));
    shown();
    ended();
  });
  setTimeout(() => {
    if (flow.view.status === "waiting") stop(flow, "failed", "The sign-in timed out: start it again");
  }, SIGN_IN_TIMEOUT_MS).unref();
  await Promise.race([urlShown, sleep(URL_WAIT_MS)]);
  return flow.view;
}

export function getSignIn(id: string): SignInView | null {
  return flows.get(id)?.view ?? null;
}

/** One GET to sbx's listener on this host. `node:http` never goes through a proxy from the environment. */
function deliver(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = get(target, { timeout: 15_000 }, (response) => {
      response.resume();
      response.on("end", () => resolve());
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
  });
}

/** Delivers the pasted redirect to sbx's listener and waits for sbx to finish the sign-in. */
export async function finishSignIn(id: string, pasted: string): Promise<SignInView> {
  const flow = flows.get(id);
  if (!flow) throw new Error("This sign-in is over: start it again");
  if (flow.view.status !== "waiting") return flow.view;
  if (!flow.callback) throw new Error("This sign-in completes in the browser sbx opened; nothing to paste");
  const target = callbackTarget(flow.callback, pasted);
  try {
    await deliver(target);
  } catch (error) {
    if (flow.view.status === "waiting") throw new Error(`sbx's sign-in did not answer: ${(error as Error).message}`);
  }
  await Promise.race([flow.ended, sleep(20_000)]);
  return flow.view;
}

export function cancelSignIn(id: string): void {
  const flow = flows.get(id);
  if (flow) stop(flow, "cancelled", null);
}

/** Ends every sign-in still waiting, when the plugin stops. */
export function cancelAllSignIns(): void {
  for (const flow of flows.values()) if (flow.view.status === "waiting") stop(flow, "cancelled", null);
}
