import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginPaths, type PluginPaths } from "../server/paths";
import { resetStarshipForTests, starshipSource, starshipStatus, syncStarship } from "../server/starship";
import { STARSHIP_BUILDS, STARSHIP_VERSION } from "../shared/starship";

let root: string;
let paths: PluginPaths;
let server: Server;
let archive: Buffer;
let url: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-starship-"));
  paths = pluginPaths({ XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") }, join(root, "home"));
  resetStarshipForTests();
  // A release-shaped archive: one executable named starship at its root.
  const build = join(root, "build");
  mkdirSync(build);
  writeFileSync(join(build, "starship"), "#!/bin/sh\necho fake starship\n");
  execFileSync("tar", ["-czf", join(root, "starship.tar.gz"), "-C", build, "starship"]);
  archive = readFileSync(join(root, "starship.tar.gz"));
  server = createServer((request, response) => {
    if (request.url === "/starship.tar.gz") response.end(archive);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/starship.tar.gz`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("the plugin's Starship", () => {
  it("pins a release build per architecture", () => {
    expect(starshipSource("x64")).toEqual({
      url: `https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}/starship-x86_64-unknown-linux-musl.tar.gz`,
      sha256: STARSHIP_BUILDS.x64.sha256,
      version: STARSHIP_VERSION,
    });
    expect(starshipSource("arm64")?.url).toContain("aarch64-unknown-linux-musl");
    expect(starshipSource("ia32")).toBeNull();
  });

  it("downloads a build that matches its SHA-256 into the plugin's folder, once", async () => {
    const source = { url, sha256: sha256(archive), version: "9.9.9" };
    await syncStarship(paths, true, source);
    const binary = join(paths.binDir, "starship");
    expect(readFileSync(binary, "utf8")).toContain("fake starship");
    expect(statSync(binary).mode & 0o111).not.toBe(0);
    expect(starshipStatus(paths, true)).toEqual({ enabled: true, version: "9.9.9", installing: false, error: null });

    // In place: no second download.
    await new Promise((resolve) => server.close(resolve));
    await syncStarship(paths, true, source);
    expect(starshipStatus(paths, true).error).toBeNull();
    server.listen(0, "127.0.0.1");
  });

  it("refuses a download that does not match its pinned SHA-256", async () => {
    await syncStarship(paths, true, { url, sha256: "0".repeat(64), version: "9.9.9" });
    expect(existsSync(join(paths.binDir, "starship"))).toBe(false);
    expect(starshipStatus(paths, true).error).toContain("does not match its pinned SHA-256");
    expect(starshipStatus(paths, false).error).toBeNull();
  });

  it("removes it when the setting is turned off", async () => {
    await syncStarship(paths, true, { url, sha256: sha256(archive), version: "9.9.9" });
    await syncStarship(paths, false);
    expect(existsSync(join(paths.binDir, "starship"))).toBe(false);
    expect(starshipStatus(paths, false)).toEqual({ enabled: false, version: null, installing: false, error: null });
  });
});
