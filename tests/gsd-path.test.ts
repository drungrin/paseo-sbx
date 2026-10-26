import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gsdPathMembers, usesGsdPath } from "../server/gsd-path";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-gsd-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function members(text: string) {
  mkdirSync(join(root, ".project"), { recursive: true });
  writeFileSync(join(root, ".project", "MEMBERS.md"), text);
  return gsdPathMembers(root, "/home/me");
}

describe("gsdPathMembers", () => {
  it("reads one checkout per member section, expanding ~ and resolving relative paths", () => {
    expect(
      members(
        [
          "# Members",
          "",
          "<!-- Written by members.py add. -->",
          "",
          "## code",
          "Checkout: ~/projects/code",
          "Remote: git@example.com:code.git",
          "",
          "## docs",
          "Checkout: ../docs  ",
          "",
        ].join("\r\n"),
      ),
    ).toEqual([
      { name: "code", path: "/home/me/projects/code" },
      { name: "docs", path: join(root, "..", "docs") },
    ]);
  });

  it("skips sections without a checkout and checkout lines outside a section", () => {
    expect(members(["Checkout: /stray", "## pending", "Remote: x", "## code", "Checkout: /p/code"].join("\n"))).toEqual([
      { name: "code", path: "/p/code" },
    ]);
  });

  it("returns no members without a MEMBERS.md", () => {
    expect(gsdPathMembers(root, "/home/me")).toEqual([]);
  });
});

describe("usesGsdPath", () => {
  it("looks for the repository's .gsd-path dir", () => {
    expect(usesGsdPath(root)).toBe(false);
    mkdirSync(join(root, ".gsd-path"));
    expect(usesGsdPath(root)).toBe(true);
  });
});
