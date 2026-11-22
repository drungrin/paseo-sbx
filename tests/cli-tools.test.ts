import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_TOOLS, cliAvailable, cliEnabled, cliScope, cliSelected, cliWanted, type CliRelease } from "../shared/cli-tools";
import { sandboxSettingsSchema } from "../shared/settings";
import {
  checkTarListing,
  classifyProbe,
  cliDirs,
  installCli,
  latestRelease,
  planCli,
  readInstalled,
  resetCliToolsForTests,
  storeClaudeToken,
  writeCliPlan,
  type FetchLike,
} from "../server/cli-tools";
import { pluginPaths } from "../server/paths";
import { buildSpec } from "../server/spec-builder";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-cli-"));
  resetCliToolsForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function paths() {
  return pluginPaths({ XDG_STATE_HOME: join(root, "state") }, join(root, "home"));
}

/** Pretends each CLI's version is installed: an executable at its entry and the record. */
function fakeInstall(p: ReturnType<typeof paths>, versions: Partial<Record<keyof typeof CLI_TOOLS, string>>) {
  const record: Record<string, unknown> = {};
  for (const [id, version] of Object.entries(versions)) {
    const entry = join(cliDirs(p).tools, id, version!, CLI_TOOLS[id as keyof typeof CLI_TOOLS].entry);
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(entry, "#!/bin/sh\n", { mode: 0o755 });
    record[id] = { version, installedAt: 1 };
  }
  writeFileSync(join(cliDirs(p).tools, "installed.json"), JSON.stringify(record));
}

const ALL = { claude: "2.1.330", codex: "0.166.0", muse: "1.4.25-R9361.1", agy: "1.5.14" };

describe("which CLIs a sandbox gets", () => {
  it("never offers the kit's own agent, nor the session's", () => {
    expect(cliAvailable("claude", "claude", null)).toBe(false);
    expect(cliAvailable("codex", "claude", null)).toBe(true);
    expect(cliAvailable("codex", "claude", "codex")).toBe(false);
    expect(cliAvailable("claude", "codex", null)).toBe(true);
    expect(cliAvailable("codex", "codex", null)).toBe(false);
    expect(cliAvailable("muse", "claude", "claude")).toBe(true);
    expect(cliAvailable("agy", "gemini", null)).toBe(true);
  });

  it("follows the repository's choices over the plugin's", () => {
    const settings = sandboxSettingsSchema.parse({
      cliTools: { enabled: ["codex", "muse"], scope: "global" },
      repos: { "git:/r/.git": { cliTools: { muse: false, agy: true }, cliScope: "sandbox" }, "git:/s/.git": { cliTools: { claude: true } } },
    });
    expect(cliSelected(settings, "git:/r/.git")).toEqual(["codex", "agy"]);
    expect(cliSelected(settings, "git:/other/.git")).toEqual(["codex", "muse"]);
    expect(cliEnabled(settings, "git:/r/.git", "muse")).toBe(false);
    expect(cliScope(settings, "git:/r/.git")).toBe("sandbox");
    expect(cliScope(settings, "git:/other/.git")).toBe("global");
    expect(cliWanted(settings)).toEqual(["claude", "codex", "muse", "agy"]);
  });
});

describe("a sandbox's plan", () => {
  function plan(options: { scope?: "global" | "sandbox"; kit?: string; agent?: "claude" | "codex" | null; enabled?: string[] } = {}) {
    const p = paths();
    const settings = sandboxSettingsSchema.parse({
      cliTools: { enabled: options.enabled ?? ["claude", "codex", "muse", "agy"], scope: options.scope ?? "global" },
    });
    const claudeConfigDir = join(p.claudeConfigs, "sb");
    return {
      p,
      claudeConfigDir,
      plan: planCli({
        paths: p,
        settings,
        repoKey: "git:/r/.git",
        sandbox: "sb",
        claudeConfigDir,
        kit: options.kit ?? "claude",
        agent: options.agent === undefined ? "claude" : options.agent,
      }),
    };
  }

  it("binds each CLI's own state, shares only the credential, and mounts the shared folder", () => {
    const p = paths();
    fakeInstall(p, ALL);
    const { plan: built, claudeConfigDir } = plan();
    expect(built.ids).toEqual(["codex", "muse", "agy"]);
    expect(built.session).toEqual(["codex", "muse", "agy"]);
    expect(built.mount).toBe(cliDirs(p).authGlobal);
    expect(built.spec?.mounts).toEqual([
      { name: ".codex", target: join(claudeConfigDir, ".paseo-sbx", "cli", "codex", "codex") },
      { name: ".config/muse", target: join(claudeConfigDir, ".paseo-sbx", "cli", "muse", "config") },
      { name: ".local/share/muse", target: join(claudeConfigDir, ".paseo-sbx", "cli", "muse", "data") },
      { name: ".gemini", target: join(claudeConfigDir, ".paseo-sbx", "cli", "agy", "gemini") },
    ]);

    writeCliPlan(built, "sb");
    const local = join(claudeConfigDir, ".paseo-sbx", "cli", "codex", "codex", "auth.json");
    expect(readlinkSync(local)).toBe(join(cliDirs(p).authGlobal, "codex", "auth.json"));
    expect(readFileSync(join(claudeConfigDir, ".paseo-sbx", "cli", "codex", "codex", ".paseo-sbx-cli"), "utf8")).toBe("paseo-sbx codex codex sb\n");

    const shim = readFileSync(join(built.spec!.path, "codex"), "utf8");
    expect(shim).toContain('for state in "$HOME/.codex"; do');
    expect(shim).toContain("exit 78");
    expect(shim).toContain("paseo-sbx-cli: codex: $state is not mounted");
    expect(shim).toContain('export CODEX_HOME="$HOME/.codex"');
    expect(shim).toContain(`exec '${join(cliDirs(p).tools, "codex", "0.166.0", "bin", "codex")}' "$@"`);
    expect(statSync(join(built.spec!.path, "codex")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(built.spec!.path, "muse"), "utf8")).toContain('export MUSE_NO_AUTO_UPDATE="1"');
    expect(readFileSync(join(built.spec!.path, "agy"), "utf8")).toContain('export AGY_CLI_DISABLE_AUTO_UPDATE="1"');
  });

  it("describes the CLIs in the manifest GSD Path reads, binding only credentials that exist", () => {
    const p = paths();
    fakeInstall(p, ALL);
    mkdirSync(join(cliDirs(p).authGlobal, "agy"), { recursive: true });
    writeFileSync(join(cliDirs(p).authGlobal, "agy", "antigravity-oauth-token"), "{}");
    const { plan: built, claudeConfigDir } = plan();
    writeCliPlan(built, "sb");
    const manifest = JSON.parse(readFileSync(built.spec!.manifest, "utf8"));
    expect(manifest).toMatchObject({ version: 1, sandbox: "sb", scope: "global" });
    expect(manifest.read_roots).toEqual([cliDirs(p).tools, built.spec!.path]);
    expect(manifest.credential_roots).toEqual([cliDirs(p).auth, p.homesDir, claudeConfigDir]);
    expect(Object.keys(manifest.clis)).toEqual(["codex", "muse", "agy"]);
    expect(manifest.clis.agy).toMatchObject({
      version: "1.5.14",
      shim: join(built.spec!.path, "agy"),
      state: ["/home/agent/.gemini"],
      credentials: [
        { path: "/home/agent/.gemini/antigravity-cli/antigravity-oauth-token", source: join(cliDirs(p).authGlobal, "agy", "antigravity-oauth-token") },
      ],
      login: "agy",
    });
    // Not signed in yet: nothing to bind.
    expect(manifest.clis.codex.credentials).toEqual([]);
    expect(manifest.clis.muse.state).toEqual(["/home/agent/.config/muse", "/home/agent/.local/share/muse"]);
  });

  it("gives a Codex session no additional codex, while the terminal of the Claude kit has it", () => {
    const p = paths();
    fakeInstall(p, ALL);
    const { plan: built } = plan({ agent: "codex" });
    expect(built.session).toEqual(["muse", "agy"]);
    const [session, terminal] = built.generations;
    expect(Object.keys(session!.shims)).toEqual(["muse", "agy"]);
    expect(Object.keys(terminal!.shims)).toEqual(["codex", "muse", "agy"]);
    expect(built.spec?.terminal.path).toBe(terminal!.dir);
    expect(session!.dir).not.toBe(terminal!.dir);
  });

  it("gives a Codex kit an additional claude that signs in with its token only", () => {
    const p = paths();
    fakeInstall(p, ALL);
    const { plan: built } = plan({ kit: "codex", agent: "codex" });
    expect(built.ids).toEqual(["claude", "muse", "agy"]);
    writeCliPlan(built, "sb");
    const shim = readFileSync(join(built.spec!.path, "claude"), "utf8");
    expect(shim).toContain("unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN");
    expect(shim).toContain('export CLAUDE_CONFIG_DIR="$HOME/.claude"');
    expect(shim).toContain(`token=$(cat '${join(cliDirs(p).authGlobal, "claude", "oauth-token")}' 2>/dev/null)`);
    expect(shim).toContain('export CLAUDE_CODE_OAUTH_TOKEN="$token"');
    // A token file is no credential to bind for a confined member.
    expect(JSON.parse(readFileSync(built.spec!.manifest, "utf8")).clis.claude.credentials).toEqual([]);
  });

  it("leaves out CLIs not installed yet, and needs no mount in the sandbox scope", () => {
    const p = paths();
    fakeInstall(p, { muse: ALL.muse });
    const { plan: built } = plan({ scope: "sandbox" });
    expect(built.ids).toEqual(["codex", "muse", "agy"]);
    expect(built.session).toEqual(["muse"]);
    expect(built.missing).toEqual(["codex", "agy"]);
    expect(built.mount).toBeNull();
  });

  it("names no CLI at all when the repository turns none on", () => {
    const { plan: built } = plan({ enabled: [] });
    expect(built.spec).toBeNull();
    expect(built.mount).toBeNull();
  });

  it("adopts a credential a CLI wrote over its link, and drops the link in the sandbox scope", () => {
    const p = paths();
    fakeInstall(p, ALL);
    const { plan: built, claudeConfigDir } = plan({ enabled: ["codex"] });
    writeCliPlan(built, "sb");
    const local = join(claudeConfigDir, ".paseo-sbx", "cli", "codex", "codex", "auth.json");
    const shared = join(cliDirs(p).authGlobal, "codex", "auth.json");

    // A renewal by rename left a file: it is newer, so it becomes the shared credential.
    rmSync(local);
    writeFileSync(local, "renewed");
    writeCliPlan(built, "sb");
    expect(readlinkSync(local)).toBe(shared);
    expect(readFileSync(shared, "utf8")).toBe("renewed");

    // An older file than the shared one is dropped.
    rmSync(local);
    writeFileSync(local, "stale");
    utimesSync(local, new Date(1_000), new Date(1_000));
    writeCliPlan(built, "sb");
    expect(readFileSync(shared, "utf8")).toBe("renewed");
    expect(lstatSync(local).isSymbolicLink()).toBe(true);

    // In the sandbox scope the link goes: the CLI signs in again, in this sandbox only.
    const { plan: own } = plan({ enabled: ["codex"], scope: "sandbox" });
    expect(writeCliPlan(own, "sb")).toEqual(["codex: the sandbox no longer shares its credential; sign in again here"]);
    expect(existsSync(local)).toBe(false);
    expect(readFileSync(shared, "utf8")).toBe("renewed");
  });

  it("keeps a generation's shims as written: a change makes a new folder", () => {
    const p = paths();
    fakeInstall(p, ALL);
    const first = plan().plan;
    writeCliPlan(first, "sb");
    writeCliPlan(first, "sb");
    fakeInstall(p, { ...ALL, codex: "0.167.0" });
    const second = plan().plan;
    expect(second.spec!.path).not.toBe(first.spec!.path);
    writeCliPlan(second, "sb");
    expect(readFileSync(join(first.spec!.path, "codex"), "utf8")).toContain("0.166.0");
    expect(readFileSync(join(second.spec!.path, "codex"), "utf8")).toContain("0.167.0");
  });
});

describe("the spec", () => {
  function repo() {
    const dir = join(root, "repo");
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    return dir;
  }

  it("mounts the shared credentials only in the global scope and names the shims", async () => {
    const p = paths();
    fakeInstall(p, ALL);
    const dir = repo();
    const repoKey = `git:${realpathSync(dir)}/.git`;
    const global = sandboxSettingsSchema.parse({ cliTools: { enabled: ["codex"], scope: "global" } });
    const built = await buildSpec({ settings: global, workspaceId: "wks_1", cwd: dir, paths: p, home: join(root, "home"), agent: "claude" });
    expect(built.mounts.find((mount) => mount.source === "cli")).toEqual({ path: cliDirs(p).authGlobal, readOnly: false, source: "cli" });
    expect(built.spec.mounts).toContain(cliDirs(p).authGlobal);
    expect(built.spec.cli?.path).toBe(built.cli?.generations[0]?.dir);
    expect(existsSync(join(built.spec.cli!.path, "codex"))).toBe(true);

    const own = sandboxSettingsSchema.parse({ cliTools: { enabled: ["codex"] }, repos: { [repoKey]: { cliScope: "sandbox" } } });
    const sandboxScope = await buildSpec({ settings: own, workspaceId: "wks_1", cwd: dir, paths: p, home: join(root, "home"), agent: "claude" });
    expect(sandboxScope.mounts.some((mount) => mount.source === "cli")).toBe(false);
    expect(sandboxScope.spec.cli?.mounts.map((mount) => mount.name)).toEqual([".codex"]);

    const none = await buildSpec({ settings: sandboxSettingsSchema.parse({}), workspaceId: "wks_1", cwd: dir, paths: p, home: join(root, "home") });
    expect(none.spec.cli).toBeNull();
    expect(none.cli).toBeNull();
  });
});

function sha(algorithm: "sha256" | "sha512", data: Buffer): string {
  return createHash(algorithm).update(data).digest("hex");
}

function respond(routes: Record<string, () => Response>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("missing", { status: 404 });
    return route();
  }) as unknown as FetchLike & { calls: string[] };
  impl.calls = calls;
  return impl;
}

describe("installing", () => {
  const binary = Buffer.from("#!/bin/sh\necho muse\n");
  const url = "https://lookaside.facebook.com/lookaside/muse/download/?file=muse";
  const release = (hex: string): CliRelease => ({ version: "1.4.26-R1.1", artifacts: { x64: { url, digest: { algorithm: "sha256", hex } } } });

  it("downloads a binary, checks its digest and makes it the active version", async () => {
    const p = paths();
    await installCli(p, "muse", release(sha("sha256", binary)), respond({ [url]: () => new Response(binary) }), "x64");
    expect(readInstalled(p).muse?.version).toBe("1.4.26-R1.1");
    const entry = join(cliDirs(p).tools, "muse", "1.4.26-R1.1", "muse");
    expect(readFileSync(entry)).toEqual(binary);
    expect(statSync(entry).mode & 0o111).not.toBe(0);
  });

  it("refuses a download whose digest does not match, and installs nothing", async () => {
    const p = paths();
    await expect(installCli(p, "muse", release("0".repeat(64)), respond({ [url]: () => new Response(binary) }), "x64")).rejects.toThrow(
      "does not match its sha256",
    );
    expect(readInstalled(p).muse).toBeUndefined();
    expect(existsSync(join(cliDirs(p).tools, "muse", "1.4.26-R1.1"))).toBe(false);
  });

  it("follows redirects only to the CLI's own hosts, over HTTPS", async () => {
    const p = paths();
    const away = respond({ [url]: () => new Response(null, { status: 302, headers: { location: "https://evil.example/muse" } }) });
    await expect(installCli(p, "muse", release(sha("sha256", binary)), away, "x64")).rejects.toThrow("refusing https://evil.example");
    expect(away.calls).toEqual([url]);
    resetCliToolsForTests();
    const plain = respond({ [url]: () => new Response(null, { status: 301, headers: { location: "http://lookaside.facebook.com/muse" } }) });
    await expect(installCli(p, "muse", release(sha("sha256", binary)), plain, "x64")).rejects.toThrow("refusing http://lookaside.facebook.com");
  });

  it("refuses a host architecture nobody qualified", async () => {
    await expect(installCli(paths(), "muse", release("0".repeat(64)), respond({}), "arm64")).rejects.toThrow("no qualified Muse Code build");
  });

  it("extracts only the CLI's folder of a tarball, without voice support", async () => {
    const p = paths();
    const source = join(root, "pkg");
    const vendor = join(source, "package", "vendor", "x86_64-unknown-linux-musl");
    mkdirSync(join(vendor, "bin"), { recursive: true });
    mkdirSync(join(vendor, "codex-resources", "voice", "lib"), { recursive: true });
    writeFileSync(join(vendor, "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(vendor, "bin", "codex-code-mode-host"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(vendor, "codex-resources", "bwrap"), "x", { mode: 0o755 });
    writeFileSync(join(vendor, "codex-resources", "voice", "lib", "big.so"), "x");
    writeFileSync(join(source, "package", "README.md"), "x");
    const tarball = join(root, "codex.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", source, "package"]);
    const data = readFileSync(tarball);
    const tgz = "https://registry.npmjs.org/@openai/codex/-/codex-0.167.0-linux-x64.tgz";
    await installCli(
      p,
      "codex",
      { version: "0.167.0", artifacts: { x64: { url: tgz, digest: { algorithm: "sha512", hex: sha("sha512", data) }, root: "package/vendor/x86_64-unknown-linux-musl" } } },
      respond({ [tgz]: () => new Response(data) }),
      "x64",
    );
    const dir = join(cliDirs(p).tools, "codex", "0.167.0");
    expect(existsSync(join(dir, "bin", "codex"))).toBe(true);
    expect(existsSync(join(dir, "bin", "codex-code-mode-host"))).toBe(true);
    expect(existsSync(join(dir, "codex-resources", "bwrap"))).toBe(true);
    expect(existsSync(join(dir, "codex-resources", "voice"))).toBe(false);
    expect(existsSync(join(dir, "README.md"))).toBe(false);
  });

  it("refuses an archive with links or paths outside it", () => {
    expect(() => checkTarListing(["a", "b"], ["-rw-r--r-- x", "lrwxrwxrwx x"])).toThrow("not a file or a folder: b");
    expect(() => checkTarListing(["../etc/passwd"], ["-rw-r--r-- x"])).toThrow("a path outside it");
    expect(() => checkTarListing(["/abs"], ["-rw-r--r-- x"])).toThrow("a path outside it");
    expect(() => checkTarListing(["ok/file", "ok/"], ["-rw-r--r-- x", "drwxr-xr-x x"])).not.toThrow();
  });
});

describe("the vendors' current releases", () => {
  it("reads each vendor's manifest and refuses artifacts off its hosts", async () => {
    const json = (value: unknown) => () => new Response(JSON.stringify(value));
    const claudeSum = "a".repeat(64);
    const claude = await latestRelease(
      "claude",
      respond({
        "https://downloads.claude.ai/claude-code-releases/latest": () => new Response("2.1.400\n"),
        "https://downloads.claude.ai/claude-code-releases/2.1.400/manifest.json": json({ platforms: { "linux-x64": { checksum: claudeSum } } }),
      }),
    );
    expect(claude).toEqual({
      version: "2.1.400",
      artifacts: { x64: { url: "https://downloads.claude.ai/claude-code-releases/2.1.400/linux-x64/claude", digest: { algorithm: "sha256", hex: claudeSum } } },
    });

    const integrity = Buffer.alloc(64, 7);
    const codex = await latestRelease(
      "codex",
      respond({
        "https://registry.npmjs.org/@openai/codex/latest": json({ version: "0.170.0" }),
        "https://registry.npmjs.org/@openai/codex/0.170.0-linux-x64": json({
          dist: { tarball: "https://registry.npmjs.org/@openai/codex/-/codex-0.170.0-linux-x64.tgz", integrity: `sha512-${integrity.toString("base64")}` },
        }),
      }),
    );
    expect(codex.artifacts.x64).toEqual({
      url: "https://registry.npmjs.org/@openai/codex/-/codex-0.170.0-linux-x64.tgz",
      digest: { algorithm: "sha512", hex: integrity.toString("hex") },
      root: "package/vendor/x86_64-unknown-linux-musl",
    });

    const manifestUrl = "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.26-R1.1&file=manifest.json";
    const muse = await latestRelease(
      "muse",
      respond({
        "https://api.meta.ai/muse-code/channels/muse-stable": json({ version: "1.4.26-R1.1", manifest_url: manifestUrl }),
        [manifestUrl]: json({ version: "1.4.26-R1.1", checksum_algorithm: "sha256", artifacts: { x86_linux: { url: "https://lookaside.facebook.com/m", checksum: "b".repeat(64) } } }),
      }),
    );
    expect(muse.version).toBe("1.4.26-R1.1");

    await expect(
      latestRelease(
        "agy",
        respond({
          "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json": json({
            version: "1.5.20",
            url: "https://evil.example/agy.tar.gz",
            sha512: "c".repeat(128),
          }),
        }),
      ),
    ).rejects.toThrow("not on one of this CLI's download hosts");

    await expect(
      latestRelease("claude", respond({ "https://downloads.claude.ai/claude-code-releases/latest": () => new Response("<html>") })),
    ).rejects.toThrow("not one");
  });
});

describe("signing in", () => {
  it("stores Claude's token readable by you only, and refuses anything else", () => {
    const p = paths();
    const file = storeClaudeToken(p, null, "global", `  sk-ant-oat01-${"x".repeat(40)}\n`);
    expect(file).toBe(join(cliDirs(p).authGlobal, "claude", "oauth-token"));
    expect(readFileSync(file, "utf8")).toBe(`sk-ant-oat01-${"x".repeat(40)}`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => storeClaudeToken(p, null, "global", "sk-ant-api03-abc")).toThrow("not a token from claude setup-token");
    const own = storeClaudeToken(p, join(p.claudeConfigs, "sb"), "sandbox", `sk-ant-oat01-${"y".repeat(40)}`);
    expect(own).toBe(join(p.claudeConfigs, "sb", ".paseo-sbx", "cli", "claude", "oauth-token"));
  });

  it("reads a probe's exit and output", () => {
    expect(classifyProbe("codex", 0, "Logged in using ChatGPT")).toEqual({ status: "ok", detail: "Logged in using ChatGPT" });
    expect(classifyProbe("codex", 1, "Not logged in")).toMatchObject({ status: "login" });
    expect(classifyProbe("muse", 1, "muse usage: not logged in: run `muse login` first")).toMatchObject({ status: "login" });
    expect(classifyProbe("agy", 0, "gemini-4-neon-high\tGemini")).toMatchObject({ status: "ok" });
    expect(classifyProbe("agy", 1, "Error: Please sign in to view available models.")).toMatchObject({ status: "login" });
    expect(classifyProbe("claude", 0, '{"loggedIn": true, "authMethod": "oauth_token"}')).toMatchObject({ status: "ok" });
    expect(classifyProbe("claude", 0, '{"loggedIn": false}')).toMatchObject({ status: "login" });
    expect(classifyProbe("agy", 78, "paseo-sbx-cli: agy: /home/agent/.gemini is not mounted")).toMatchObject({ status: "not-mounted" });
    expect(classifyProbe("muse", 127, "env: 'muse': No such file or directory")).toMatchObject({ status: "missing" });
    expect(classifyProbe("codex", 1, "token sk-proj-abcdefghijklmnopqrstuv failed").detail).toContain("****");
  });
});

describe("a state folder left by an earlier link", () => {
  it("replaces a link pointing elsewhere", () => {
    const p = paths();
    fakeInstall(p, ALL);
    const settings = sandboxSettingsSchema.parse({ cliTools: { enabled: ["muse"] } });
    const claudeConfigDir = join(p.claudeConfigs, "sb");
    const built = planCli({ paths: p, settings, repoKey: "k", sandbox: "sb", claudeConfigDir, kit: "claude", agent: null });
    const local = join(claudeConfigDir, ".paseo-sbx", "cli", "muse", "config", "auth.json");
    mkdirSync(join(local, ".."), { recursive: true });
    symlinkSync("/elsewhere/auth.json", local);
    writeCliPlan(built, "sb");
    expect(readlinkSync(local)).toBe(join(cliDirs(p).authGlobal, "muse", "auth.json"));
  });
});
