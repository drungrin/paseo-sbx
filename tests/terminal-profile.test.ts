import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginPaths, type PluginPaths } from "../server/paths";
import { TERMINAL_PROFILE_ID, ensureTerminalProfile, resetTerminalProfileForTests } from "../server/terminal-profile";
import { rememberWorkspaceSandbox } from "../server/workspaces";
import type { SandboxSpec } from "../shared/spec";

let root: string;
let paths: PluginPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-profile-"));
  paths = pluginPaths({ XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") }, join(root, "home"));
  resetTerminalProfileForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Profile = { id: string; name: string; command: string; args?: string[] };

/** The part of Paseo's API the profile uses: a config held in memory. */
function fakePaseo(terminalProfiles?: Profile[]) {
  const config: { terminalProfiles?: Profile[] } = terminalProfiles ? { terminalProfiles } : {};
  const patches: unknown[] = [];
  const paseo = {
    config: {
      get: async () => ({ config }),
      patch: async (patch: { terminalProfiles?: Profile[] }) => {
        patches.push(patch);
        Object.assign(config, patch);
      },
    },
  };
  return { paseo: paseo as never, config, patches };
}

describe("Sandbox terminal profile", () => {
  it("adds itself after Paseo's default profiles when none are stored", async () => {
    const fake = fakePaseo();
    await ensureTerminalProfile(fake.paseo, paths);
    expect(fake.config.terminalProfiles?.map((profile) => profile.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
      TERMINAL_PROFILE_ID,
    ]);
    expect(fake.config.terminalProfiles?.at(-1)).toEqual({
      id: TERMINAL_PROFILE_ID,
      name: "Sandbox terminal",
      command: paths.shellLauncher,
      args: [],
    });
    await ensureTerminalProfile(fake.paseo, paths);
    expect(fake.patches).toHaveLength(1);
  });

  it("stays removed once you remove it, and follows the launcher when it moves", async () => {
    const mine = { id: "mine", name: "Mine", command: "zsh" };
    const first = fakePaseo([mine]);
    await ensureTerminalProfile(first.paseo, paths);
    expect(first.config.terminalProfiles?.map((profile) => profile.id)).toEqual(["mine", TERMINAL_PROFILE_ID]);

    resetTerminalProfileForTests();
    const removed = fakePaseo([mine]);
    await ensureTerminalProfile(removed.paseo, paths);
    expect(removed.patches).toEqual([]);

    resetTerminalProfileForTests();
    const moved = fakePaseo([{ id: TERMINAL_PROFILE_ID, name: "Shell in the VM", command: "/old/paseo-sbx-shell" }, mine]);
    await ensureTerminalProfile(moved.paseo, paths);
    expect(moved.config.terminalProfiles).toEqual([
      { id: TERMINAL_PROFILE_ID, name: "Shell in the VM", command: paths.shellLauncher, args: [] },
      mine,
    ]);
  });
});

describe("workspace records", () => {
  it("keeps the spec without its variables, for workspace ids only", () => {
    const spec = { version: 3, name: "paseo-app-00000001", env: { LICENSE_KEY: "s3cret" } } as unknown as SandboxSpec;
    rememberWorkspaceSandbox(paths, "wks_1", spec);
    rememberWorkspaceSandbox(paths, "../escape", spec);
    rememberWorkspaceSandbox(paths, null, spec);
    const record = JSON.parse(readFileSync(join(paths.workspacesDir, "wks_1.json"), "utf8"));
    expect(record).toEqual({ version: 3, name: "paseo-app-00000001", env: {} });
    expect(existsSync(join(paths.root, "escape.json"))).toBe(false);
  });
});
