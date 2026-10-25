import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxSettingsSchema } from "../shared/settings";
import { pluginPaths } from "../server/paths";
import { buildSpec } from "../server/spec-builder";

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
    expect(spec.mounts).toEqual([`${home}/tools:ro`, "/does-not-matter", `${hostClaude}:ro`]);
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
    expect(spec.mounts).toEqual([join(repo, ".git")]);
  });

  it("forwards configured variables from the env file first, then the daemon environment", async () => {
    const { home, repo, env, paths } = setup();
    mkdirSync(join(home, ".config", "paseo-sbx"), { recursive: true });
    writeFileSync(paths.defaultEnvFile, "LICENSE_KEY=from-file\n");
    const settings = sandboxSettingsSchema.parse({
      envNames: ["LICENSE_KEY", "FROM_DAEMON", "ABSENT"],
      overrides: { [`directory:${repo}`]: { envNames: ["EXTRA"], memoryGiB: 6 } },
      isolation: "directory",
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
