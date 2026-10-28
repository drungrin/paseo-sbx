import { describe, expect, it } from "vitest";
import { mcpLoadState, panelBadges, panelNeeds } from "../client/panel";
import type { Description } from "../client/queries";

function description(overrides: Partial<Description> = {}): Description {
  return {
    key: "directory:/home/me/app",
    name: "paseo-app-1",
    status: "running",
    repoKey: "git:/home/me/app/.git",
    repoName: "app",
    memoryMiB: 8192,
    repoMemoryGiB: null,
    cpus: 0,
    repoCpus: null,
    resourcesApplied: true,
    rssMiB: 2048,
    workspace: "/home/me/app",
    mounts: [],
    removedMounts: [],
    gsdPath: null,
    env: [],
    template: { configured: null, sandbox: null, status: "match" },
    agents: [],
    recreateBlockers: [],
    templatePrep: null,
    siblings: [],
    operations: [],
    services: { snapshotAt: null, listeners: [], publications: [] },
    mcp: { autoLoad: [], loaded: [], unreadable: null, pendingUnload: [], errors: {} },
    ...overrides,
  };
}

describe("panelNeeds", () => {
  it("is empty for a sandbox that matches its repository's settings", () => {
    expect(panelNeeds(description())).toEqual([]);
  });

  it("lists failed operations first, then what the sandbox lacks, each with its tab", () => {
    const needs = panelNeeds(
      description({
        operations: [
          { id: "o1", kind: "save-template", target: "x", status: "failed", error: "no space left", result: null, startedAt: 0 },
        ],
        template: { configured: "docker.io/library/app:2", sandbox: "docker.io/library/app:1", status: "diverged" },
        resourcesApplied: false,
        mounts: [
          { path: "/home/me/.config/gh", readOnly: true, source: "repo", exists: true, applied: false },
          { path: "/home/me/.gone", readOnly: false, source: "settings", exists: false, applied: null },
        ],
        removedMounts: ["/home/me/.old"],
        env: [
          { name: "SET", scope: "all", present: true, reserved: false },
          { name: "UNSET", scope: "repo", present: false, reserved: false },
          { name: "PATH", scope: "repo", present: false, reserved: true },
        ],
        services: {
          snapshotAt: 1,
          listeners: [],
          publications: [{ guestPort: 9000, allInterfaces: false, reserved: true, auto: false, hostPort: null }],
        },
      }),
    );
    expect(needs.map((need) => [need.tone, need.tab, need.title])).toEqual([
      ["danger", "template", "Save template failed"],
      ["warning", "template", "The repository's template changed"],
      ["warning", "resources", "Memory or CPUs changed since the sandbox was created"],
      ["warning", "mounts", "2 mount changes wait for a recreation"],
      ["warning", "mounts", "1 mount missing on the host"],
      ["warning", "variables", "1 variable without a value"],
      ["warning", "services", "A port is not published"],
    ]);
    expect(needs[1].detail).toContain("app:1");
    expect(needs[3].detail).toBe("+ ~/.config/gh   − ~/.old");
    expect(needs[5].detail).toBe("UNSET");
  });

  it("does not ask for a recreation before the sandbox exists", () => {
    const needs = panelNeeds(
      description({
        status: null,
        mounts: [{ path: "/home/me/.config/gh", readOnly: true, source: "repo", exists: true, applied: null }],
        services: {
          snapshotAt: null,
          listeners: [],
          publications: [{ guestPort: 9000, allInterfaces: false, reserved: true, auto: false, hostPort: null }],
        },
      }),
    );
    expect(needs).toEqual([]);
  });

  it("names GSD Path members without a checkout once, under mounts", () => {
    const needs = panelNeeds(
      description({
        mounts: [{ path: "/home/me/web", readOnly: false, source: "member", exists: false, applied: null }],
        gsdPath: { enabled: true, members: [{ name: "web", path: "/home/me/web", available: false }] },
      }),
    );
    expect(needs).toEqual([
      { tone: "warning", title: "GSD Path member without a checkout", detail: "web (~/web)", tab: "mounts" },
    ]);
  });
});

describe("panelBadges", () => {
  it("counts what each tab holds, toned where it needs you", () => {
    const badges = panelBadges(
      description({
        template: { configured: "b", sandbox: "a", status: "diverged" },
        env: [{ name: "UNSET", scope: "repo", present: false, reserved: false }],
        services: { snapshotAt: 1, listeners: [{ port: 5173, addresses: ["127.0.0.1"] }], publications: [] },
      }),
    );
    expect(badges).toEqual({
      overview: { label: "2", tone: "warning" },
      services: { label: "1" },
      template: { label: "Changed", tone: "warning" },
      resources: null,
      mounts: { label: "1" },
      variables: { label: "1 missing", tone: "warning" },
      mcp: null,
    });
  });
});

describe("MCP in the workspace panel", () => {
  const mcp = {
    autoLoad: ["docs"],
    loaded: ["docs", "own"],
    unreadable: null,
    pendingUnload: ["old"],
    errors: { broken: "502 Bad Gateway" },
  };

  it("tells a loaded server from one an agent loaded, one waiting and one that failed", () => {
    const data = description({ mcp });
    expect(mcpLoadState(data, "docs", true)).toEqual({ label: "Loaded", tone: "success" });
    expect(mcpLoadState(data, "own", false)).toEqual({ label: "Loaded by an agent", tone: "neutral" });
    expect(mcpLoadState(data, "new", true)).toEqual({ label: "Loading…", tone: "accent" });
    expect(mcpLoadState(data, "old", false).label).toBe("Unloads when the sandbox next starts");
    expect(mcpLoadState(data, "broken", true)).toEqual({ label: "Could not load it: 502 Bad Gateway", tone: "danger" });
    expect(mcpLoadState(description({ status: null }), "docs", true).label).toBe("Loads when the sandbox is created");
    expect(mcpLoadState(description({ mcp: { ...mcp, loaded: null, errors: {} } }), "docs", true).label).toBe("On");
  });

  it("asks for attention on failures and on an sbx record it cannot read", () => {
    const needs = panelNeeds(description({ mcp: { ...mcp, unreadable: "gateways/x.json: runtime_id: Required" } }));
    expect(needs.map((need) => [need.title, need.tab])).toEqual([
      ["1 MCP server could not be loaded or unloaded", "mcp"],
      ["sbx changed how it records MCP servers", "mcp"],
    ]);
    expect(panelBadges(description({ mcp })).mcp).toEqual({ label: "1", tone: "warning" });
    expect(panelBadges(description({ mcp: { ...mcp, errors: {} } })).mcp).toEqual({ label: "1" });
  });
});
