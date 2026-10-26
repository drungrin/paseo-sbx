import { describe, expect, it } from "vitest";
import {
  TEMPLATE_TAG_PATTERN,
  isExcluded,
  memoryMiB,
  mergeMounts,
  normalizeTemplateRef,
  parseEnvFile,
  parseMount,
  parsePortList,
  sandboxIdentity,
  sandboxName,
  templatePrepName,
} from "../shared/spec";

const GiB = 1024 ** 3;

describe("sandboxIdentity", () => {
  it("keys by workspace in workspace mode and by directory otherwise", () => {
    expect(sandboxIdentity("workspace", "wks_1", "/p/app").key).toBe("workspace:wks_1");
    expect(sandboxIdentity("directory", "wks_1", "/p/app").key).toBe("directory:/p/app");
    expect(sandboxIdentity("workspace", null, "/p/app").key).toBe("directory:/p/app");
  });

  it("gives two workspaces sharing a directory different sandboxes only in workspace mode", () => {
    const a = sandboxIdentity("workspace", "wks_a", "/p/app");
    const b = sandboxIdentity("workspace", "wks_b", "/p/app");
    expect(a.name).not.toBe(b.name);
    expect(sandboxIdentity("directory", "wks_a", "/p/app").name).toBe(
      sandboxIdentity("directory", "wks_b", "/p/app").name,
    );
  });
});

describe("sandboxName", () => {
  it("is stable and only uses characters sbx accepts", () => {
    const name = sandboxName("workspace:wks_1", "/home/u/My Project_v2.0/");
    expect(name).toBe(sandboxName("workspace:wks_1", "/home/u/My Project_v2.0/"));
    expect(name).toMatch(/^paseo-my-project-v2-0-[0-9a-f]{8}$/);
  });

  it("falls back to a slug for directories without usable characters", () => {
    expect(sandboxName("directory:/", "/")).toMatch(/^paseo-root-[0-9a-f]{8}$/);
  });
});

describe("memoryMiB", () => {
  const settings = { memoryPercent: 10, memoryFloorGiB: 2 };

  it("takes the percentage of host memory", () => {
    expect(memoryMiB(settings, undefined, 30 * GiB)).toBe(3072);
  });

  it("never goes below the floor", () => {
    expect(memoryMiB(settings, undefined, 8 * GiB)).toBe(2048);
  });

  it("prefers the repository's value", () => {
    expect(memoryMiB(settings, { memoryGiB: 6 }, 30 * GiB)).toBe(6144);
  });

  it("stays within what sbx accepts: 512 MiB to 75% of the host", () => {
    expect(memoryMiB(settings, { memoryGiB: 28 }, 30 * GiB)).toBe(23040);
    expect(memoryMiB({ memoryPercent: 1, memoryFloorGiB: 0 }, undefined, 8 * GiB)).toBe(512);
  });
});

describe("templates", () => {
  it("expands short references the way sbx template ls reports them", () => {
    expect(normalizeTemplateRef("storefront:v3")).toBe("docker.io/library/storefront:v3");
    expect(normalizeTemplateRef("storefront")).toBe("docker.io/library/storefront:latest");
    expect(normalizeTemplateRef("team/tools:1")).toBe("docker.io/team/tools:1");
    expect(normalizeTemplateRef("ghcr.io/team/tools:1")).toBe("ghcr.io/team/tools:1");
    expect(normalizeTemplateRef("docker.io/library/x:y")).toBe("docker.io/library/x:y");
  });

  it("accepts only tags that are safe to hand to sbx", () => {
    expect(TEMPLATE_TAG_PATTERN.test("storefront:20261026-1530")).toBe(true);
    expect(TEMPLATE_TAG_PATTERN.test("team/storefront:v1")).toBe(true);
    expect(TEMPLATE_TAG_PATTERN.test("Storefront")).toBe(false);
    expect(TEMPLATE_TAG_PATTERN.test("x; rm -rf ~")).toBe(false);
  });

  it("names the preparation sandbox per repository, apart from working sandboxes", () => {
    const name = templatePrepName("git:/home/u/repo/.git", "/home/u/repo");
    expect(name).toMatch(/^paseo-tpl-repo-[0-9a-f]{8}$/);
    expect(name).not.toBe(sandboxName("git:/home/u/repo/.git", "/home/u/repo"));
  });
});

describe("mounts", () => {
  it("expands ~/ and reads the :ro suffix", () => {
    expect(parseMount("~/.gsd-path", "/home/u")).toEqual({ path: "/home/u/.gsd-path", readOnly: false });
    expect(parseMount("/opt/tools/:ro", "/home/u")).toEqual({ path: "/opt/tools", readOnly: true });
    expect(parseMount("relative/path", "/home/u")).toBeNull();
  });

  it("keeps the writable entry when a path is listed twice", () => {
    expect(
      mergeMounts([
        { path: "/a", readOnly: true },
        { path: "/a", readOnly: false },
        { path: "/b", readOnly: true },
      ]),
    ).toEqual([
      { path: "/a", readOnly: false },
      { path: "/b", readOnly: true },
    ]);
  });

  it("matches excluded paths on directory boundaries", () => {
    expect(isExcluded("/p/app/src", ["/p/app"], "/home/u")).toBe(true);
    expect(isExcluded("/p/application", ["/p/app"], "/home/u")).toBe(false);
    expect(isExcluded("/home/u/x", ["~/x"], "/home/u")).toBe(true);
  });
});

describe("parseEnvFile", () => {
  it("reads the dotenv subset", () => {
    const text = [
      "# comment",
      "export A=1",
      'B="two words"',
      "C='single'",
      "D = spaced",
      "not a line",
    ].join("\n");
    expect(parseEnvFile(text)).toEqual({ A: "1", B: "two words", C: "single", D: "spaced" });
  });
});

describe("parsePortList", () => {
  it("keeps valid ports only", () => {
    expect(parsePortList("6767, 8317\n0, 70000, abc")).toEqual([6767, 8317]);
  });
});
