import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_SHARED, sandboxSettingsSchema } from "../shared/settings";
import { pluginPaths } from "../server/paths";
import { repoIdentity } from "../server/repo";
import { migrateSettings } from "../server/settings-migration";
import { buildSpec } from "../server/spec-builder";
import { writeSandboxState } from "../server/state";

let root: string;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args], {
    stdio: "ignore",
  });
}

function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), name);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-sbx-repo-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("repoIdentity", () => {
  it("gives every worktree of a repository the main checkout's key", async () => {
    const main = repo("app");
    git(main, "worktree", "add", "-q", "-b", "feat", join(root, "app-feat"));
    const fromMain = await repoIdentity(join(main));
    const fromWorktree = await repoIdentity(join(root, "app-feat"));
    expect(fromMain).toEqual({ key: `git:${main}/.git`, root: main });
    expect(fromWorktree).toEqual(fromMain);
  });

  it("keeps sibling submodules apart", async () => {
    const libA = repo("lib-a");
    const libB = repo("lib-b");
    const host = repo("host");
    git(host, "submodule", "add", "-q", libA, "a");
    git(host, "submodule", "add", "-q", libB, "b");
    const a = await repoIdentity(join(host, "a"));
    const b = await repoIdentity(join(host, "b"));
    expect(a.key).toBe(`git:${host}/.git/modules/a`);
    expect(b.key).toBe(`git:${host}/.git/modules/b`);
    expect(a.root).toBe(join(host, "a"));
  });

  it("keys a bare repository's worktrees by the bare directory", async () => {
    const source = repo("src");
    const bare = join(root, "shared.git");
    execFileSync("git", ["clone", "-q", "--bare", source, bare]);
    git(bare, "worktree", "add", "-q", join(root, "bare-wt"), "main");
    expect((await repoIdentity(join(root, "bare-wt"))).key).toBe(`git:${bare}`);
  });

  it("handles a separate git dir, symlinked paths and plain directories", async () => {
    const separate = join(root, "sep");
    execFileSync("git", ["init", "-q", `--separate-git-dir=${join(root, "sep-git")}`, separate]);
    expect((await repoIdentity(separate)).key).toBe(`git:${join(root, "sep-git")}`);

    const main = repo("linked");
    symlinkSync(main, join(root, "link"));
    expect((await repoIdentity(join(root, "link"))).key).toBe(`git:${main}/.git`);

    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await repoIdentity(`${plain}/`)).toEqual({ key: `dir:${plain}`, root: plain });
  });
});

describe("settings migration", () => {
  const v1Globals = { routeClaudeAgents: true, isolation: "directory", memoryPercent: 12, networkAllow: ["**"] };

  it("keeps the global settings and parses as version 2", async () => {
    const migrated = await migrateSettings({ ...v1Globals, overrides: {} }, 1);
    const parsed = sandboxSettingsSchema.parse(migrated);
    expect(parsed).toMatchObject({ routeClaudeAgents: true, isolation: "directory", memoryPercent: 12, repos: {}, legacyOverrides: {} });
    expect(migrated).not.toHaveProperty("overrides");
  });

  it("moves directory overrides to their repository and keeps the rest for you", async () => {
    const main = repo("app");
    git(main, "worktree", "add", "-q", "-b", "feat", join(root, "app-feat"));
    git(main, "worktree", "add", "-q", "-b", "fix", join(root, "app-fix"));
    const other = repo("other");
    const migrated = sandboxSettingsSchema.parse(
      await migrateSettings(
        {
          ...v1Globals,
          overrides: {
            [`directory:${other}`]: { memoryGiB: 6, mounts: ["~/.x"], envNames: ["TOKEN"] },
            [`directory:${main}`]: { memoryGiB: 4, mounts: [], envNames: [] },
            [`directory:${join(root, "app-feat")}`]: { memoryGiB: 8, mounts: [], envNames: [] },
            [`directory:${join(root, "app-fix")}`]: { memoryGiB: 4, mounts: [], envNames: [] },
            "workspace:wks_1": { memoryGiB: 3, mounts: [], envNames: [] },
          },
        },
        1,
      ),
    );
    expect(migrated.repos).toEqual({
      [`git:${other}/.git`]: { template: "", memoryGiB: 6, mounts: ["~/.x"], envNames: ["TOKEN"], autoPublish: [] },
    });
    expect(Object.keys(migrated.legacyOverrides).sort()).toEqual(
      [`directory:${main}`, `directory:${join(root, "app-feat")}`, `directory:${join(root, "app-fix")}`, "workspace:wks_1"].sort(),
    );
    expect(migrated.legacyOverrides["workspace:wks_1"].reason).toBe("workspace");
    expect(migrated.legacyOverrides[`directory:${main}`].reason).toBe("conflict");
  });

  it("stops sharing settings.json from a list at the old default, and keeps a list you changed", async () => {
    const legacy = ["settings.json", "CLAUDE.md", "skills", "agents", "commands", "rules"];
    const atDefault = sandboxSettingsSchema.parse(await migrateSettings({ claudeShared: [...legacy].reverse() }, 2));
    expect(atDefault.claudeShared).toEqual(DEFAULT_CLAUDE_SHARED);
    expect(atDefault.claudeShared).not.toContain("settings.json");
    const custom = ["settings.json", "CLAUDE.md", "keybindings.json"];
    expect(sandboxSettingsSchema.parse(await migrateSettings({ claudeShared: custom }, 2)).claudeShared).toEqual(custom);
    expect(sandboxSettingsSchema.parse(await migrateSettings({ claudeShared: [] }, 2)).claudeShared).toEqual([]);
    // Never saved: the new default.
    expect(sandboxSettingsSchema.parse(await migrateSettings({}, 2)).claudeShared).toEqual(DEFAULT_CLAUDE_SHARED);
    // Version 1 goes through both steps.
    const fromV1 = sandboxSettingsSchema.parse(await migrateSettings({ ...v1Globals, claudeShared: legacy, overrides: {} }, 1));
    expect(fromV1.claudeShared).toEqual(DEFAULT_CLAUDE_SHARED);
    expect(fromV1.repos).toEqual({});
  });
});

describe("buildSpec per repository", () => {
  function setup() {
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const env = { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(home, ".config") };
    return { home, env, paths: pluginPaths(env, home) };
  }

  it("applies the repository's template, memory, mounts and variables in any of its worktrees", async () => {
    const { home, env, paths } = setup();
    const main = repo("app");
    git(main, "worktree", "add", "-q", "-b", "feat", join(root, "app-feat"));
    const settings = sandboxSettingsSchema.parse({
      template: "global:v1",
      isolation: "directory",
      claudeShared: [],
      repos: { [`git:${main}/.git`]: { template: "app:v2", memoryGiB: 5, mounts: ["/opt/app-tools:ro"], envNames: ["APP_KEY"] } },
    });
    const { spec, missingEnv } = await buildSpec({
      settings,
      workspaceId: null,
      cwd: join(root, "app-feat"),
      paths,
      env: { ...env },
      home,
      hostMemoryBytes: 32 * 1024 ** 3,
    });
    expect(spec.repoKey).toBe(`git:${main}/.git`);
    expect(spec.workspace).toBe(join(root, "app-feat"));
    expect(spec.template).toBe("app:v2");
    expect(spec.memory).toBe("5120m");
    expect(spec.mounts).toContain("/opt/app-tools:ro");
    expect(missingEnv).toEqual(["APP_KEY"]);

    const elsewhere = await buildSpec({ settings, workspaceId: null, cwd: repo("other"), paths, env, home });
    expect(elsewhere.spec.template).toBe("global:v1");
  });

  it("keeps the repository an existing sandbox was created for", async () => {
    const { home, env, paths } = setup();
    const main = repo("app");
    const settings = sandboxSettingsSchema.parse({ claudeShared: [] });
    const binding = { key: "workspace:wks_1", name: "paseo-app-0badc0de", claudeConfigDir: join(root, "cfg") };
    writeSandboxState(paths, binding.name, { repoKey: "git:/elsewhere/.git" });
    const { spec } = await buildSpec({ settings, workspaceId: "wks_1", cwd: main, paths, env, home, binding });
    expect(spec.repoKey).toBe("git:/elsewhere/.git");
  });
});
