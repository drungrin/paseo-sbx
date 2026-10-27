import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxSettingsSchema } from "../shared/settings";
import { pluginPaths } from "../server/paths";
import { buildSpec, claudeProjectDirName, copyHostTranscripts, prepareClaudeConfigDir } from "../server/spec-builder";

const GiB = 1024 ** 3;
let root: string;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-spec-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const home = join(root, "home");
  const hostClaude = join(home, ".claude");
  mkdirSync(join(hostClaude, "skills"), { recursive: true });
  writeFileSync(join(hostClaude, "settings.json"), "{}");
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "x");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const env = { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(home, ".config") };
  const paths = pluginPaths(env, home);
  return { home, hostClaude, repo, env, paths };
}

describe("buildSpec", () => {
  it("mounts the git toplevel and links the shared Claude items into a per-sandbox config dir", async () => {
    const { home, hostClaude, repo, env, paths } = setup();
    const settings = sandboxSettingsSchema.parse({ mounts: ["~/tools:ro", "/does-not-matter"] });
    const { spec } = await buildSpec({
      settings,
      workspaceId: "wks_1",
      cwd: join(repo, "src"),
      paths,
      env,
      home,
      hostMemoryBytes: 30 * GiB,
    });

    expect(spec.workspace).toBe(repo);
    expect(spec.key).toBe("workspace:wks_1");
    expect(spec.memory).toBe("3072m");
    // The shared Claude items one by one, never the config dir with its credentials.
    expect(spec.mounts).toEqual([
      `${home}/tools:ro`,
      "/does-not-matter",
      `${hostClaude}/settings.json:ro`,
      `${hostClaude}/skills:ro`,
      paths.homesDir,
    ]);
    expect(spec.claudeConfigDir).toBe(join(paths.claudeConfigs, spec.name));
    expect(readlinkSync(join(spec.claudeConfigDir, "settings.json"))).toBe(join(hostClaude, "settings.json"));
    expect(lstatSync(join(spec.claudeConfigDir, "skills")).isSymbolicLink()).toBe(true);
    // Items missing on the host are not linked.
    expect(existsSync(join(spec.claudeConfigDir, "agents"))).toBe(false);
  });

  it("mounts a worktree's common git dir writable and skips mounts inside the workspace", async () => {
    const { home, repo, env, paths } = setup();
    const worktree = join(root, "wt");
    git(repo, "worktree", "add", "-q", "-b", "feat", worktree);
    const settings = sandboxSettingsSchema.parse({ mounts: [join(worktree, "inner")], claudeShared: [] });
    const { spec } = await buildSpec({ settings, workspaceId: null, cwd: worktree, paths, env, home });

    expect(spec.workspace).toBe(worktree);
    expect(spec.key).toBe(`directory:${worktree}`);
    expect(spec.mounts).toEqual([join(repo, ".git"), paths.homesDir]);
  });

  it("forwards configured variables from the env file first, then the daemon environment", async () => {
    const { home, repo, env, paths } = setup();
    mkdirSync(join(home, ".config", "paseo-sbx"), { recursive: true });
    writeFileSync(paths.defaultEnvFile, "LICENSE_KEY=from-file\n");
    const settings = sandboxSettingsSchema.parse({
      envNames: ["LICENSE_KEY", "FROM_DAEMON", "ABSENT"],
      repos: { [`git:${realpathSync(repo)}/.git`]: { envNames: ["EXTRA"], memoryGiB: 6 } },
      isolation: "directory",
      githubHttps: false,
    });
    const { spec, missingEnv } = await buildSpec({
      settings,
      workspaceId: "wks_ignored",
      cwd: repo,
      paths,
      env: { ...env, FROM_DAEMON: "daemon", LICENSE_KEY: "loses-to-file", EXTRA: "x" },
      home,
    });

    expect(spec.env).toEqual({ LICENSE_KEY: "from-file", FROM_DAEMON: "daemon", EXTRA: "x" });
    expect(missingEnv).toEqual(["ABSENT"]);
    expect(spec.memory).toBe("6144m");
  });
});

describe("buildSpec bindings and validation", () => {
  it("reuses an agent's binding even after the isolation mode changed", async () => {
    const { home, repo, env, paths } = setup();
    const binding = { key: "workspace:wks_old", name: "paseo-repo-0badc0de", claudeConfigDir: join(root, "old-config") };
    const settings = sandboxSettingsSchema.parse({ isolation: "directory" });
    const { spec } = await buildSpec({ settings, workspaceId: "wks_old", cwd: repo, paths, env, home, binding });
    expect(spec.key).toBe(binding.key);
    expect(spec.name).toBe(binding.name);
    expect(spec.claudeConfigDir).toBe(binding.claudeConfigDir);
    expect(spec.workspace).toBe(repo);
  });

  it("refuses to forward variables the sbx client reserves", async () => {
    const { home, repo, env, paths } = setup();
    const settings = sandboxSettingsSchema.parse({ envNames: ["PATH", "SBX_TOKEN", "DOCKER_HOST", "OK"], githubHttps: false });
    const { spec, rejectedEnv } = await buildSpec({
      settings,
      workspaceId: null,
      cwd: repo,
      paths,
      env: { ...env, PATH: "/x", SBX_TOKEN: "t", DOCKER_HOST: "d", OK: "1" },
      home,
    });
    expect(spec.env).toEqual({ OK: "1" });
    expect(rejectedEnv).toEqual(["PATH", "SBX_TOKEN", "DOCKER_HOST"]);
  });

  it("leaves the filesystem alone for read-only callers", async () => {
    const { home, repo, env, paths } = setup();
    const settings = sandboxSettingsSchema.parse({});
    const { spec } = await buildSpec({ settings, workspaceId: "wks_1", cwd: repo, paths, env, home, prepare: false });
    expect(existsSync(spec.claudeConfigDir)).toBe(false);
  });

  it("keys a non-git directory by its canonical path", async () => {
    const { home, env, paths } = setup();
    const plain = join(root, "plain");
    mkdirSync(plain);
    const settings = sandboxSettingsSchema.parse({ isolation: "directory", claudeShared: [] });
    const a = await buildSpec({ settings, workspaceId: null, cwd: `${plain}/`, paths, env, home });
    const b = await buildSpec({ settings, workspaceId: null, cwd: plain, paths, env, home });
    expect(a.spec.workspace).toBe(plain);
    expect(a.spec.name).toBe(b.spec.name);
  });
});

describe("buildSpec resources and git", () => {
  it("lets a repository pick its CPUs and sizes every sandbox's Docker disk", async () => {
    const { home, repo, env, paths } = setup();
    const repoKey = `git:${realpathSync(repo)}/.git`;
    const settings = sandboxSettingsSchema.parse({ cpus: 8, dockerDiskGiB: 60, repos: { [repoKey]: { cpus: 4 } } });
    const { spec } = await buildSpec({ settings, workspaceId: null, cwd: repo, paths, env, home });
    expect(spec.cpus).toBe(4);
    expect(spec.dockerDisk).toBe("60g");
    const defaults = await buildSpec({ settings: sandboxSettingsSchema.parse({}), workspaceId: null, cwd: repo, paths, env, home });
    expect(defaults.spec.cpus).toBe(0);
    expect(defaults.spec.dockerDisk).toBeNull();
  });

  it("rewrites GitHub SSH remotes to HTTPS after the git config you forward", async () => {
    const { home, repo, env, paths } = setup();
    mkdirSync(join(home, ".config", "shell"), { recursive: true });
    writeFileSync(
      join(home, ".config", "shell", "env.sh"),
      "export GIT_CONFIG_COUNT=1\nexport GIT_CONFIG_KEY_0=core.editor\nexport GIT_CONFIG_VALUE_0=vi\n",
    );
    const settings = sandboxSettingsSchema.parse({
      envFile: "~/.config/shell/env.sh",
      envNames: ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"],
    });
    const { spec } = await buildSpec({ settings, workspaceId: null, cwd: repo, paths, env, home });
    expect(spec.env).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.editor",
      GIT_CONFIG_VALUE_0: "vi",
      GIT_CONFIG_KEY_1: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_1: "git@github.com:",
      GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_2: "ssh://git@github.com/",
    });
    const off = await buildSpec({
      settings: sandboxSettingsSchema.parse({ githubHttps: false }),
      workspaceId: null,
      cwd: repo,
      paths,
      env,
      home,
    });
    expect(off.spec.env).toEqual({});
  });
});

describe("buildSpec for agents", () => {
  it("gives Codex its shared home and the daemon's port", async () => {
    const { home, repo, env, paths } = setup();
    const settings = sandboxSettingsSchema.parse({ forwardPorts: [5000] });
    const { spec } = await buildSpec({ settings, workspaceId: null, cwd: join(repo, "src"), paths, env, home, agent: "codex", daemonPort: 6767 });
    expect(spec.agent).toBe("codex");
    expect(spec.binary).toBe("codex");
    expect(spec.agentCwd).toBe(join(repo, "src"));
    expect(spec.agentHome).toEqual({ env: "CODEX_HOME", path: join(paths.homesDir, "codex") });
    expect(spec.forwardPorts).toEqual([5000, 6767]);
    expect(spec.mounts).toContain(paths.homesDir);
  });

  it("signs Claude in through the sbx secret only when nothing else signs it in", async () => {
    const { home, hostClaude, repo, env, paths } = setup();
    const settings = sandboxSettingsSchema.parse({ githubHttps: false });
    const anthropic = [{ scope: "global", service: "anthropic" }];
    const withSecret = await buildSpec({ settings, workspaceId: null, cwd: repo, paths, env, home, secrets: anthropic });
    expect(withSecret.spec.env).toEqual({ ANTHROPIC_API_KEY: "proxy-managed" });
    const none = await buildSpec({ settings, workspaceId: null, cwd: repo, paths, env, home, secrets: [] });
    expect(none.spec.env).toEqual({});

    writeFileSync(join(hostClaude, "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "t" } }));
    const gateway = await buildSpec({ settings, workspaceId: null, cwd: repo, paths, env, home, secrets: anthropic });
    expect(gateway.spec.env).toEqual({});
    writeFileSync(join(hostClaude, "settings.json"), "{ not json");
    const unreadable = await buildSpec({ settings, workspaceId: null, cwd: repo, paths, env, home, secrets: anthropic });
    expect(unreadable.spec.env).toEqual({});
    writeFileSync(join(hostClaude, "settings.json"), "{}");
    const bedrock = await buildSpec({
      settings,
      workspaceId: null,
      cwd: repo,
      paths,
      env: { ...env, CLAUDE_CODE_USE_BEDROCK: "1" },
      home,
      secrets: anthropic,
    });
    expect(bedrock.spec.env).toEqual({});
  });
});

describe("buildSpec for GSD Path", () => {
  function coordinator(home: string, repo: string) {
    const member = join(home, "projects", "member");
    mkdirSync(member, { recursive: true });
    git(member, "init", "-q", "-b", "main");
    writeFileSync(join(member, "README.md"), "x");
    git(member, "add", ".");
    git(member, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const memberWorktree = join(root, "member-wt");
    git(member, "worktree", "add", "-q", "-b", "feat", memberWorktree);
    mkdirSync(join(repo, ".gsd-path"));
    mkdirSync(join(repo, ".project"));
    writeFileSync(
      join(repo, ".project", "MEMBERS.md"),
      [
        "# Members",
        "",
        "## code",
        "Checkout: ~/projects/member",
        "Remote: git@example.com:code.git",
        "",
        "## worktree",
        `Checkout: ${memberWorktree}`,
        "",
        "## gone",
        "Checkout: /nowhere/gone",
        "",
      ].join("\n"),
    );
    mkdirSync(join(home, ".gsd-path"));
    return { member, memberWorktree };
  }

  it("mounts ~/.gsd-path and the member checkouts writable, and links ~/.gsd-path into the guest's home", async () => {
    const { home, hostClaude, repo, env, paths } = setup();
    const { member, memberWorktree } = coordinator(home, repo);
    const settings = sandboxSettingsSchema.parse({ mounts: ["~/.config/gh:ro", "/opt/shared"] });
    const built = await buildSpec({ settings, workspaceId: null, cwd: repo, paths, env, home });

    expect(built.spec.mounts).toEqual([
      `${home}/.config/gh:ro`,
      "/opt/shared",
      join(home, ".gsd-path"),
      member,
      memberWorktree,
      join(member, ".git"),
      "/nowhere/gone",
      `${hostClaude}/settings.json:ro`,
      `${hostClaude}/skills:ro`,
      paths.homesDir,
    ]);
    expect(built.mounts.map((mount) => mount.source)).toEqual([
      "settings",
      "settings",
      "gsd-path",
      "member",
      "member",
      "git",
      "member",
      "claude",
      "claude",
      "agents",
    ]);
    // Only what you chose under your home: checkouts and Claude's config are reached by path.
    expect(built.spec.homeMounts).toEqual([
      { name: ".config/gh", target: join(home, ".config", "gh") },
      { name: ".gsd-path", target: join(home, ".gsd-path") },
    ]);
    expect(built.spec.env.GSD_PATH_WORKTREE_ROOT).toBe(join(home, ".gsd-path", "projects"));
    expect(built.gsdPath).toEqual({
      enabled: true,
      members: [
        { name: "code", path: member },
        { name: "worktree", path: memberWorktree },
        { name: "gone", path: "/nowhere/gone" },
      ],
    });
  });

  it("mounts nothing for GSD Path when the setting is off, but still reports the members", async () => {
    const { home, repo, env, paths } = setup();
    const { member } = coordinator(home, repo);
    const settings = sandboxSettingsSchema.parse({ gsdPath: false, claudeShared: [] });
    const built = await buildSpec({ settings, workspaceId: null, cwd: repo, paths, env, home });
    expect(built.spec.mounts).toEqual([paths.homesDir]);
    expect(built.spec.homeMounts).toEqual([]);
    expect(built.spec.env.GSD_PATH_WORKTREE_ROOT).toBeUndefined();
    expect(built.gsdPath?.enabled).toBe(false);
    expect(built.gsdPath?.members[0]).toEqual({ name: "code", path: member });
  });

  it("reports no GSD Path for a repository without a .gsd-path dir", async () => {
    const { home, repo, env, paths } = setup();
    const built = await buildSpec({ settings: sandboxSettingsSchema.parse({}), workspaceId: null, cwd: repo, paths, env, home });
    expect(built.gsdPath).toBeNull();
  });
});

describe("Claude config dir", () => {
  it("drops links to items no longer shared and keeps what Claude wrote", () => {
    const { hostClaude } = setup();
    mkdirSync(join(hostClaude, "agents"));
    const dir = join(root, "sandbox-config");
    prepareClaudeConfigDir(dir, hostClaude, ["settings.json", "agents"]);
    writeFileSync(join(dir, ".claude.json"), "{}");
    prepareClaudeConfigDir(dir, hostClaude, ["settings.json"]);
    expect(existsSync(join(dir, "agents"))).toBe(false);
    expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, ".claude.json"))).toBe(true);
  });

  it("copies the project's host transcripts for an import without overwriting", () => {
    const { hostClaude, repo } = setup();
    const name = claudeProjectDirName(repo);
    mkdirSync(join(hostClaude, "projects", name), { recursive: true });
    writeFileSync(join(hostClaude, "projects", name, "s1.jsonl"), "host");
    const dir = join(root, "sandbox-config");
    mkdirSync(join(dir, "projects", name), { recursive: true });
    writeFileSync(join(dir, "projects", name, "s2.jsonl"), "sandbox");
    copyHostTranscripts(hostClaude, repo, dir);
    copyHostTranscripts(hostClaude, repo, dir);
    expect(readFileSync(join(dir, "projects", name, "s1.jsonl"), "utf8")).toBe("host");
    expect(readFileSync(join(dir, "projects", name, "s2.jsonl"), "utf8")).toBe("sandbox");
  });

  it("encodes project paths like Claude Code", () => {
    expect(claudeProjectDirName("/home/u/my.repo")).toBe("-home-u-my-repo");
    expect(claudeProjectDirName(`/${"a".repeat(300)}`)).toMatch(/^-a{199}-[0-9a-z]+$/);
  });
});

