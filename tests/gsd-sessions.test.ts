import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GSD_DEFAULT_SESSION_DIRS,
  gsdDaemonConfigPath,
  gsdSessionsKey,
  reconcileGsdSessionDirs,
  rememberGsdSessionSource,
} from "../server/gsd-sessions";
import { pluginPaths, type PluginPaths } from "../server/paths";
import { writeSandboxState } from "../server/state";
import { sandboxSettingsSchema, type SandboxSettings } from "../shared/settings";

let root: string;
let paths: PluginPaths;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-gsd-sessions-"));
  paths = pluginPaths({ XDG_STATE_HOME: join(root, "state") }, join(root, "home"));
  configPath = join(root, "home", ".gsd-path", "daemon.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function settings(values: Record<string, unknown> = {}): SandboxSettings {
  return sandboxSettingsSchema.parse(values);
}

function writeConfig(data: unknown): void {
  mkdirSync(join(root, "home", ".gsd-path"), { recursive: true });
  writeFileSync(configPath, typeof data === "string" ? data : `${JSON.stringify(data)}\n`);
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

/** A sandbox of a repo, with its config dir; `gsd` gives the repo a `.gsd-path/` dir. */
function sandbox(name: string, { gsd = true, record = true } = {}) {
  const workspace = join(root, "repos", name);
  mkdirSync(gsd ? join(workspace, ".gsd-path") : workspace, { recursive: true });
  const claudeConfigDir = join(paths.claudeConfigs, `paseo-${name}`);
  mkdirSync(claudeConfigDir, { recursive: true });
  const repoKey = `git:${workspace}/.git`;
  if (record) writeSandboxState(paths, `paseo-${name}`, { key: `directory:${workspace}`, repoKey, workspace, claudeConfigDir });
  return { workspace, claudeConfigDir, repoKey, projects: join(claudeConfigDir, "projects") };
}

describe("reconcileGsdSessionDirs", () => {
  it("writes GSD Path's default list with the sandbox folders when the config has none", () => {
    writeConfig({ parents: ["/work"], prices_note: "kept" });
    const box = sandbox("alpha");
    const result = reconcileGsdSessionDirs(paths, settings(), configPath);
    expect(result.status).toBe("updated");
    expect(readConfig()).toEqual({ parents: ["/work"], prices_note: "kept", session_dirs: [...GSD_DEFAULT_SESSION_DIRS, box.projects] });
    expect(existsSync(box.projects)).toBe(true);
  });

  it("appends to your list and leaves your entries in place", () => {
    writeConfig({ session_dirs: ["/mine/b", "/mine/a"] });
    const box = sandbox("alpha");
    reconcileGsdSessionDirs(paths, settings(), configPath);
    expect(readConfig().session_dirs).toEqual(["/mine/b", "/mine/a", box.projects]);
  });

  it("does not write when the list already matches", () => {
    const box = sandbox("alpha");
    writeConfig({ session_dirs: [box.projects] });
    const before = statSync(configPath).mtimeMs;
    expect(reconcileGsdSessionDirs(paths, settings(), configPath).status).toBe("unchanged");
    expect(statSync(configPath).mtimeMs).toBe(before);
  });

  it("leaves a config without session_dirs alone when there is nothing to list", () => {
    writeConfig({ parents: [] });
    sandbox("plain", { gsd: false });
    expect(reconcileGsdSessionDirs(paths, settings(), configPath).status).toBe("unchanged");
    expect(readConfig()).toEqual({ parents: [] });
  });

  it("skips repos without GSD Path and template preparations", () => {
    writeConfig({ session_dirs: [] });
    const box = sandbox("alpha");
    sandbox("plain", { gsd: false });
    writeSandboxState(paths, "paseo-prep", { kind: "template-prep", repoKey: box.repoKey, workspace: box.workspace });
    reconcileGsdSessionDirs(paths, settings(), configPath);
    expect(readConfig().session_dirs).toEqual([box.projects]);
  });

  it("removes a repo's folder when its integration is turned off, and only what it added", () => {
    const alpha = sandbox("alpha");
    const beta = sandbox("beta");
    writeConfig({ session_dirs: ["/mine", beta.projects] });
    reconcileGsdSessionDirs(paths, settings(), configPath);
    expect(readConfig().session_dirs).toEqual(["/mine", beta.projects, alpha.projects]);
    const off = settings({ repos: { [alpha.repoKey]: { gsdPath: false }, [beta.repoKey]: { gsdPath: false } } });
    reconcileGsdSessionDirs(paths, off, configPath);
    // beta's folder was yours before the plugin saw it: it stays.
    expect(readConfig().session_dirs).toEqual(["/mine", beta.projects]);
  });

  it("lets a repo's choice win over the global one", () => {
    writeConfig({ session_dirs: [] });
    const alpha = sandbox("alpha");
    const beta = sandbox("beta");
    reconcileGsdSessionDirs(paths, settings({ gsdPath: false, repos: { [alpha.repoKey]: { gsdPath: true } } }), configPath);
    expect(readConfig().session_dirs).toEqual([alpha.projects]);
    reconcileGsdSessionDirs(paths, settings({ repos: { [alpha.repoKey]: { gsdPath: false } } }), configPath);
    expect(readConfig().session_dirs).toEqual([beta.projects]);
  });

  it("keeps a removed sandbox's folder while its logs are on the host", () => {
    writeConfig({ session_dirs: [] });
    const box = sandbox("alpha", { record: false });
    rememberGsdSessionSource(paths, { claudeConfigDir: box.claudeConfigDir, repoKey: box.repoKey, workspace: box.workspace });
    reconcileGsdSessionDirs(paths, settings(), configPath);
    expect(readConfig().session_dirs).toEqual([box.projects]);
    rmSync(box.claudeConfigDir, { recursive: true });
    reconcileGsdSessionDirs(paths, settings(), configPath);
    expect(readConfig().session_dirs).toEqual([]);
  });

  it("lists the shared Codex sessions when Codex is enabled", () => {
    writeConfig({ session_dirs: [] });
    const box = sandbox("alpha");
    reconcileGsdSessionDirs(paths, settings({ enabledAgents: ["claude", "codex"] }), configPath);
    expect(readConfig().session_dirs).toEqual([box.projects, join(paths.homesDir, "codex", "sessions")]);
  });

  it("writes nothing without a GSD Path config or with an unreadable one", () => {
    sandbox("alpha");
    expect(reconcileGsdSessionDirs(paths, settings(), configPath).status).toBe("no-config");
    expect(existsSync(configPath)).toBe(false);
    for (const broken of ["{not json", "[]"]) {
      writeConfig(broken);
      expect(reconcileGsdSessionDirs(paths, settings(), configPath).status).toBe("invalid-config");
      expect(readFileSync(configPath, "utf8")).toBe(broken);
    }
  });

  it("saves with sorted keys and two-space indents, as GSD Path does", () => {
    writeConfig({ prices: { m: { output: 2, input: 1 } }, excludes: [] });
    const box = sandbox("alpha");
    reconcileGsdSessionDirs(paths, settings(), configPath);
    const expected = { excludes: [], prices: { m: { input: 1, output: 2 } }, session_dirs: [...GSD_DEFAULT_SESSION_DIRS, box.projects] };
    expect(readFileSync(configPath, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it("follows the plugin's state dir", () => {
    writeConfig({ session_dirs: [] });
    const box = sandbox("alpha");
    reconcileGsdSessionDirs(paths, settings(), configPath);
    expect(box.projects.startsWith(join(root, "state", "paseo-sbx", "claude"))).toBe(true);
    expect(readConfig().session_dirs).toEqual([box.projects]);
  });
});

describe("rememberGsdSessionSource", () => {
  it("is true only for a config dir it had not seen", () => {
    const source = { claudeConfigDir: "/c/one", repoKey: "git:/r/.git", workspace: "/r" };
    expect(rememberGsdSessionSource(paths, source)).toBe(true);
    expect(rememberGsdSessionSource(paths, source)).toBe(false);
  });
});

describe("gsdDaemonConfigPath", () => {
  it("follows GSD_DAEMON_CONFIG, else ~/.gsd-path/daemon.json", () => {
    expect(gsdDaemonConfigPath({ GSD_DAEMON_CONFIG: "/x/d.json" }, "/home/me")).toBe("/x/d.json");
    expect(gsdDaemonConfigPath({}, "/home/me")).toBe("/home/me/.gsd-path/daemon.json");
  });
});

describe("gsdSessionsKey", () => {
  it("changes only with the settings that decide the folders", () => {
    const base = gsdSessionsKey(settings());
    expect(gsdSessionsKey(settings({ cpus: 4 }))).toBe(base);
    expect(gsdSessionsKey(settings({ gsdPath: false }))).not.toBe(base);
    expect(gsdSessionsKey(settings({ enabledAgents: ["claude", "codex"] }))).not.toBe(base);
    expect(gsdSessionsKey(settings({ repos: { r: { gsdPath: false } } }))).not.toBe(base);
  });
});
