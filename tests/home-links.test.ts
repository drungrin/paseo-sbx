import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_LINKS_SOURCE } from "../server/wrapper-source";

let root: string;
let guestHome: string;
let script: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-links-"));
  guestHome = join(root, "agent");
  mkdirSync(guestHome);
  script = join(root, "home-links.sh");
  writeFileSync(script, HOME_LINKS_SOURCE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function links(...pairs: string[]) {
  const result = spawnSync("sh", [script, ...pairs], { env: { HOME: guestHome, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

function mounted(name: string) {
  const path = join(root, "host", name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("home-links.sh", () => {
  it("links each name under the guest's home to its mounted target, creating parent dirs", () => {
    const gsd = mounted(".gsd-path");
    const gh = mounted(".config/gh");
    links(".gsd-path", gsd, ".config/gh", gh);
    expect(readlinkSync(join(guestHome, ".gsd-path"))).toBe(gsd);
    expect(readlinkSync(join(guestHome, ".config", "gh"))).toBe(gh);
  });

  it("repoints a link and leaves what the template put there", () => {
    const gsd = mounted(".gsd-path");
    symlinkSync("/elsewhere", join(guestHome, ".gsd-path"));
    mkdirSync(join(guestHome, ".config", "gh"), { recursive: true });
    const output = links(".gsd-path", gsd, ".config/gh", mounted(".config/gh"));
    expect(readlinkSync(join(guestHome, ".gsd-path"))).toBe(gsd);
    expect(lstatSync(join(guestHome, ".config", "gh")).isDirectory()).toBe(true);
    expect(output).toContain("exists in the sandbox; not linking it");
  });

  it("skips targets sbx did not mount", () => {
    links(".gsd-path", join(root, "host", "missing"));
    expect(() => lstatSync(join(guestHome, ".gsd-path"))).toThrow();
  });
});
