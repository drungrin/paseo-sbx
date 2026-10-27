import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogClaudeSettings } from "../server/catalog";
import { daemonPort } from "../server/daemon";
import { catalogName } from "../shared/spec";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-catalog-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("catalog", () => {
  it("keeps the gateway's token and any key helper out of the catalog's Claude settings", () => {
    expect(
      catalogClaudeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "t" }, apiKeyHelper: "pass", model: "opus", permissions: { allow: [] } }),
    ).toEqual({ model: "opus", permissions: { allow: [] } });
    expect(catalogClaudeSettings(null)).toEqual({});
  });

  it("names each instance's catalog apart, since sbx keeps policies per name for every instance", () => {
    expect(catalogName("codex", "/a/sbx")).toMatch(/^paseo-catalog-codex-[0-9a-f]{8}$/);
    expect(catalogName("codex", "/a/sbx")).not.toBe(catalogName("codex", "/b/sbx"));
  });
});

describe("daemonPort", () => {
  function withConfig(listen: unknown) {
    mkdirSync(join(root, "paseo"), { recursive: true });
    writeFileSync(join(root, "paseo", "config.json"), JSON.stringify({ daemon: { listen } }));
    return daemonPort({ PASEO_HOME: join(root, "paseo") }, root);
  }

  it("reads the port the daemon listens on", () => {
    expect(withConfig("0.0.0.0:6790")).toBe(6790);
    expect(withConfig("7000")).toBe(7000);
  });

  it("has no port for a unix socket, and Paseo's default without a config", () => {
    expect(withConfig("/run/paseo.sock")).toBeNull();
    expect(daemonPort({ PASEO_HOME: join(root, "missing") }, root)).toBe(6767);
  });
});
