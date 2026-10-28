import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpAutoLoad, mcpChoicesKey, mcpNameFromUrl, planMcp } from "../shared/mcp";
import { sandboxSettingsSchema, type SandboxSettings } from "../shared/settings";
import { addMcpServer, applyMcpChoices, gatewaysDir, listMcpServers, readLoadedMcp, removeMcpServer } from "../server/mcp";
import { callbackTarget, cancelSignIn, finishSignIn, getSignIn, parseAuthorizationUrl, startSignIn } from "../server/mcp-signin";
import { installBinFiles, pluginPaths, type PluginPaths } from "../server/paths";
import { readSandboxState, writeSandboxState } from "../server/state";
import { installFakeSbx, type FakeSbx } from "./fake-sbx";

let root: string;
let paths: PluginPaths;
let fake: FakeSbx;
const savedEnv = { ...process.env };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-sbx-mcp-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  fake = installFakeSbx(root);
  Object.assign(process.env, fake.env);
  paths = pluginPaths({ XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(home, ".config") }, home);
  installBinFiles(paths);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

function settings(values: Partial<SandboxSettings> = {}): SandboxSettings {
  return { ...sandboxSettingsSchema.parse({}), ...values };
}

/** Registered servers (`oauth` in a URL makes it an OAuth one) and working sandboxes of repos. */
function setUp(options: {
  servers?: Record<string, { url: string; headers?: string[]; authorized?: boolean }>;
  sandboxes?: Record<string, string>;
  stopped?: string[];
  loaded?: Record<string, string[]>;
}) {
  const state = {
    sandboxes: Object.keys(options.sandboxes ?? {}),
    stopped: options.stopped ?? [],
    mcp: Object.fromEntries(
      Object.entries(options.servers ?? {}).map(([name, server]) => [
        name,
        {
          url: server.url,
          headers: server.headers ?? [],
          oauth: server.url.includes("oauth"),
          authorized: server.authorized ?? false,
        },
      ]),
    ),
  };
  writeFileSync(fake.env.FAKE_SBX_STATE, JSON.stringify(state));
  for (const [name, repoKey] of Object.entries(options.sandboxes ?? {})) writeSandboxState(paths, name, { repoKey });
  mkdirSync(gatewaysDir(paths), { recursive: true });
  for (const [name, loaded] of Object.entries(options.loaded ?? {})) {
    writeFileSync(join(gatewaysDir(paths), `${name}.json`), JSON.stringify({ runtime_id: name, dynamic_added_set: loaded }));
  }
}

const sbxArgs = () => fake.calls().map((call) => call.args.join(" "));

describe("MCP choices", () => {
  it("loads a repository's own choice over the global one", () => {
    const values = settings({
      mcpGlobal: ["docs", "search"],
      repos: { "git:a": { template: "", mounts: [], envNames: [], autoPublish: [], mcp: { search: false, tracker: true } } },
    });
    expect(mcpAutoLoad(values, "git:a")).toEqual(["docs", "tracker"]);
    expect(mcpAutoLoad(values, "git:b")).toEqual(["docs", "search"]);
    expect(mcpChoicesKey(values)).not.toBe(mcpChoicesKey(settings({ mcpGlobal: ["docs", "search"] })));
  });

  it("plans loads for what the gateway lacks and unloads only for what was turned off", () => {
    expect(planMcp({ wanted: ["a", "b"], before: ["a", "c"], pending: ["d"], loaded: ["a", "c", "agent-added"] })).toEqual({
      load: ["b"],
      unload: ["c"],
    });
    // Unknown gateway contents: load every choice again (a no-op for sbx) and try every unload.
    expect(planMcp({ wanted: ["a"], before: ["c"], pending: [], loaded: null })).toEqual({ load: ["a"], unload: ["c"] });
  });

  it("names a server after its URL's host", () => {
    expect(mcpNameFromUrl("https://mcp.exa.ai/mcp")).toBe("exa");
    expect(mcpNameFromUrl("https://mcp.context7.com/mcp")).toBe("context7");
    expect(mcpNameFromUrl("https://api.githubcopilot.com/mcp/")).toBe("githubcopilot");
    expect(mcpNameFromUrl("not a url")).toBe("");
  });
});

describe("MCP sign-in addresses", () => {
  const printed =
    'Open this URL to authorize MCP server "docs":\nhttps://auth.example/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A40123%2Fcallback&state=abc\n';

  it("reads the authorization page and the loopback address sbx waits on", () => {
    expect(parseAuthorizationUrl(printed)).toEqual({
      url: "https://auth.example/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A40123%2Fcallback&state=abc",
      callback: { port: 40123, path: "/callback", state: "abc" },
    });
    expect(parseAuthorizationUrl("resolving MCP server docs")).toBeNull();
  });

  it("delivers only this sign-in's redirect, to this host", () => {
    const expected = { port: 40123, path: "/callback", state: "abc" };
    expect(callbackTarget(expected, " http://localhost:40123/callback?code=c1&state=abc ")).toBe(
      "http://127.0.0.1:40123/callback?code=c1&state=abc",
    );
    expect(() => callbackTarget(expected, "http://evil.example:40123/callback?code=c&state=abc")).toThrow(/not this sign-in's/);
    expect(() => callbackTarget(expected, "http://127.0.0.1:22/callback?code=c&state=abc")).toThrow(/not this sign-in's/);
    expect(() => callbackTarget(expected, "http://127.0.0.1:40123/callback?code=c&state=old")).toThrow(/another sign-in/);
    expect(() => callbackTarget(expected, "http://127.0.0.1:40123/callback?state=abc")).toThrow(/no authorization code/);
    expect(() => callbackTarget(expected, "code=c")).toThrow(/whole address/);
  });
});

describe("MCP servers", () => {
  it("lists the servers with their sign-in and the sandboxes that loaded them", async () => {
    setUp({
      servers: {
        docs: { url: "https://oauth.docs.example/mcp" },
        search: { url: "https://search.example/mcp", headers: ["Authorization: Bearer ${api-key}"] },
      },
      sandboxes: { "paseo-app-00000001": "git:a", "paseo-web-00000002": "git:b" },
      loaded: { "paseo-app-00000001": ["docs"], "paseo-web-00000002": ["docs", "search"] },
    });
    const registry = await listMcpServers(paths);
    expect(registry.unrecognized).toBeNull();
    expect(registry.sandboxes).toBe(2);
    expect(registry.servers).toEqual([
      expect.objectContaining({
        name: "docs",
        status: "needs-auth",
        auth: "oauth",
        loadedIn: ["paseo-app-00000001", "paseo-web-00000002"],
      }),
      expect.objectContaining({ name: "search", status: "needs-secret", auth: "api-key", loadedIn: ["paseo-web-00000002"] }),
    ]);
  });

  it("says what it could not read when sbx's formats change", async () => {
    setUp({ servers: { docs: { url: "https://docs.example/mcp" } }, sandboxes: { "paseo-app-00000001": "git:a" } });
    writeFileSync(join(gatewaysDir(paths), "paseo-app-00000001.json"), JSON.stringify({ runtime: "renamed" }));
    expect(readLoadedMcp(paths, "paseo-app-00000001", true).unreadable).toMatch(/runtime_id/);
    // sbx writes the record when the gateway first starts: only a running sandbox must have one.
    expect(readLoadedMcp(paths, "paseo-never-started-00000003", false)).toEqual({ loaded: [], unreadable: null });
    expect(readLoadedMcp(paths, "paseo-never-started-00000003", true).unreadable).toMatch(/does not exist for a running sandbox/);
    const registry = await listMcpServers(paths);
    expect(registry.servers.map((server) => server.name)).toEqual(["docs"]);
    expect(registry.unrecognized).toMatch(/paseo-app-00000001\.json: runtime_id/);

    process.env.FAKE_SBX_MCP_LS = JSON.stringify({ servers: [] });
    expect((await listMcpServers(paths)).unrecognized).toMatch(/sbx mcp ls --json printed an unexpected shape/);
  });

  it("adds a server with an API key that reaches sbx over stdin only", async () => {
    setUp({});
    const server = await addMcpServer(paths, {
      name: "search",
      url: "https://search.example/mcp",
      apiKey: { header: "Authorization", value: " sk-secret-1 " },
    });
    expect(server).toEqual(expect.objectContaining({ name: "search", status: "ready", auth: "api-key" }));
    expect(sbxArgs()).toContain(
      "mcp add search --url https://search.example/mcp --skip-auth --header Authorization: Bearer ${api-key}",
    );
    expect(sbxArgs().join("\n")).not.toContain("sk-secret-1");
    expect(JSON.parse(readFileSync(fake.env.FAKE_SBX_STATE, "utf8")).secrets["mcp:search:api-key"]).toBe("sk-secret-1");

    const plain = await addMcpServer(paths, {
      name: "tracker",
      url: "https://tracker.example/mcp",
      apiKey: { header: "X-Api-Key", value: "k" },
    });
    expect(plain.auth).toBe("api-key");
    expect(sbxArgs()).toContain("mcp add tracker --url https://tracker.example/mcp --skip-auth --header X-Api-Key: ${api-key}");
  });

  it("refuses plain http, a taken name and a name sbx would refuse", async () => {
    setUp({ servers: { docs: { url: "https://docs.example/mcp" } } });
    await expect(addMcpServer(paths, { name: "web", url: "http://web.example/mcp", apiKey: null })).rejects.toThrow(/Only https/);
    await expect(addMcpServer(paths, { name: "docs", url: "https://docs.example/mcp", apiKey: null })).rejects.toThrow(
      /already registered/,
    );
    await expect(addMcpServer(paths, { name: "-x", url: "https://x.example/mcp", apiKey: null })).rejects.toThrow(/Name it with/);
    expect(sbxArgs().some((args) => args.startsWith("mcp add"))).toBe(false);
  });

  it("unloads a removed server from running sandboxes now and from stopped ones at their next start", async () => {
    setUp({
      servers: { search: { url: "https://search.example/mcp", headers: ["Authorization: Bearer ${api-key}"] } },
      sandboxes: { "paseo-app-00000001": "git:a", "paseo-web-00000002": "git:b" },
      stopped: ["paseo-web-00000002"],
      loaded: { "paseo-app-00000001": ["search"], "paseo-web-00000002": ["search"] },
    });
    writeSandboxState(paths, "paseo-app-00000001", { repoKey: "git:a", mcpAutoLoad: ["search"] });
    await removeMcpServer(paths, "search");
    expect(readLoadedMcp(paths, "paseo-app-00000001", true).loaded).toEqual([]);
    expect(readSandboxState(paths, "paseo-app-00000001")?.mcpAutoLoad).toEqual([]);
    expect(readSandboxState(paths, "paseo-web-00000002")?.mcpUnload).toEqual(["search"]);
    expect(sbxArgs()).toEqual(expect.arrayContaining(["mcp rm search --force", "secret rm mcp:search:api-key -f"]));
    expect(sbxArgs()).not.toContain("mcp unload search --sandbox paseo-web-00000002");
  });
});

describe("applying MCP choices", () => {
  it("loads the choices into running and stopped sandboxes and unloads what was turned off", async () => {
    setUp({
      servers: { docs: { url: "https://docs.example/mcp" }, search: { url: "https://search.example/mcp" } },
      sandboxes: { "paseo-app-00000001": "git:a", "paseo-web-00000002": "git:b" },
      stopped: ["paseo-web-00000002"],
    });
    await applyMcpChoices(paths, settings({ mcpGlobal: ["docs", "search"] }));
    expect(readLoadedMcp(paths, "paseo-app-00000001", true).loaded).toEqual(["docs", "search"]);
    expect(readLoadedMcp(paths, "paseo-web-00000002", true).loaded).toEqual(["docs", "search"]);

    const off = settings({
      mcpGlobal: ["docs"],
      repos: { "git:a": { template: "", mounts: [], envNames: [], autoPublish: [], mcp: { docs: false } } },
    });
    await applyMcpChoices(paths, off);
    expect(readLoadedMcp(paths, "paseo-app-00000001", true).loaded).toEqual([]);
    expect(readSandboxState(paths, "paseo-app-00000001")).toEqual(expect.objectContaining({ mcpAutoLoad: [], mcpUnload: [] }));
    // A stopped sandbox cannot unload yet: its next launch does.
    expect(readLoadedMcp(paths, "paseo-web-00000002", true).loaded).toEqual(["docs", "search"]);
    expect(readSandboxState(paths, "paseo-web-00000002")).toEqual(
      expect.objectContaining({ mcpAutoLoad: ["docs"], mcpUnload: ["search"] }),
    );

    fake.clearCalls();
    await applyMcpChoices(paths, off);
    expect(sbxArgs().filter((args) => args.startsWith("mcp"))).toEqual([]);
  });

  it("keeps servers an agent loaded itself and records what failed", async () => {
    setUp({
      servers: {
        docs: { url: "https://docs.example/mcp" },
        broken: { url: "https://broken.example/mcp" },
        own: { url: "https://own.example/mcp" },
      },
      sandboxes: { "paseo-app-00000001": "git:a" },
      loaded: { "paseo-app-00000001": ["own"] },
    });
    process.env.FAKE_SBX_MCP_FAIL = "broken";
    await applyMcpChoices(paths, settings({ mcpGlobal: ["broken", "docs"] }));
    expect(readLoadedMcp(paths, "paseo-app-00000001", true).loaded).toEqual(["docs", "own"]);
    expect(readSandboxState(paths, "paseo-app-00000001")?.mcpErrors).toEqual({
      broken: expect.stringContaining("502 Bad Gateway"),
    });

    delete process.env.FAKE_SBX_MCP_FAIL;
    await applyMcpChoices(paths, settings({ mcpGlobal: [] }));
    expect(readLoadedMcp(paths, "paseo-app-00000001", true).loaded).toEqual(["own"]);
  });
});

describe("MCP sign-in", () => {
  it("shows the authorization page and finishes with the address the browser ended on", async () => {
    setUp({ servers: { docs: { url: "https://oauth.docs.example/mcp" } } });
    const flow = await startSignIn(paths, "docs");
    expect(flow).toEqual(
      expect.objectContaining({
        server: "docs",
        status: "waiting",
        url: expect.stringContaining("https://auth.example.test/authorize"),
      }),
    );
    const page = new URL(flow.url ?? "");
    const back = new URL(page.searchParams.get("redirect_uri") ?? "");
    expect(flow.callbackOrigin).toBe(`http://127.0.0.1:${back.port}`);

    // A stale address is refused by the plugin, so it cannot end this sign-in.
    await expect(finishSignIn(flow.id, `http://127.0.0.1:${back.port}/callback?code=c&state=stale`)).rejects.toThrow(
      /another sign-in/,
    );
    expect(getSignIn(flow.id)?.status).toBe("waiting");

    const done = await finishSignIn(
      flow.id,
      `http://localhost:${back.port}/callback?code=c&state=${page.searchParams.get("state")}`,
    );
    expect(done).toEqual(expect.objectContaining({ status: "done", error: null }));
    expect((await listMcpServers(paths)).servers[0].status).toBe("ready");
  });

  it("cancels a sign-in and replaces a waiting one for the same server", async () => {
    setUp({ servers: { docs: { url: "https://oauth.docs.example/mcp" } } });
    const first = await startSignIn(paths, "docs");
    const second = await startSignIn(paths, "docs");
    expect(getSignIn(first.id)?.status).toBe("cancelled");
    cancelSignIn(second.id);
    expect(getSignIn(second.id)?.status).toBe("cancelled");
    await expect(startSignIn(paths, "../x")).rejects.toThrow(/not an MCP server name/);
  });
});
