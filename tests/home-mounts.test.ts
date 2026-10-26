import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_MOUNTS_SOURCE } from "../server/wrapper-source";

let root: string;
let guestHome: string;
let script: string;
let stubs: string;

// The script runs as the sandbox user and mounts with sudo. Here sudo only records the mount and
// mountpoint reports what it recorded, so the test checks what the script asks for.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-sbx-mounts-"));
  guestHome = join(root, "agent");
  mkdirSync(guestHome);
  script = join(root, "home-mounts.sh");
  writeFileSync(script, HOME_MOUNTS_SOURCE);
  stubs = join(root, "stubs");
  mkdirSync(stubs);
  const log = join(root, "mounts.log");
  writeFileSync(join(stubs, "sudo"), `#!/bin/sh\n[ "$1" = -n ] && shift\necho "$*" >>'${log}'\n`);
  writeFileSync(
    join(stubs, "mountpoint"),
    `#!/bin/sh\n[ "$1" = -q ] && shift\ngrep -q " $1\\$" '${log}' 2>/dev/null\n`,
  );
  chmodSync(join(stubs, "sudo"), 0o755);
  chmodSync(join(stubs, "mountpoint"), 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mountHome(...pairs: string[]) {
  const result = spawnSync("sh", [script, ...pairs], {
    env: { HOME: guestHome, PATH: `${stubs}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

function binds(): string[] {
  const log = join(root, "mounts.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

function hostDir(name: string) {
  const path = join(root, "host", name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("home-mounts.sh", () => {
  it("bind-mounts each target at its name under the guest's home, creating what it mounts on", () => {
    const gsd = hostDir(".gsd-path");
    const gh = hostDir(".config/gh");
    const gitconfig = join(hostDir("files"), "gitconfig");
    writeFileSync(gitconfig, "[user]\n");
    mountHome(".gsd-path", gsd, ".config/gh", gh, ".netrc", gitconfig);
    expect(binds()).toEqual([
      `mount --bind ${gsd} ${guestHome}/.gsd-path`,
      `mount --bind ${gh} ${guestHome}/.config/gh`,
      `mount --bind ${gitconfig} ${guestHome}/.netrc`,
    ]);
    expect(lstatSync(join(guestHome, ".config", "gh")).isDirectory()).toBe(true);
    expect(lstatSync(join(guestHome, ".netrc")).isFile()).toBe(true);
  });

  it("does not mount twice in one boot", () => {
    const gsd = hostDir(".gsd-path");
    mountHome(".gsd-path", gsd);
    mountHome(".gsd-path", gsd);
    expect(binds()).toHaveLength(1);
  });

  it("replaces the link an earlier version made, and leaves what the template put there", () => {
    const gsd = hostDir(".gsd-path");
    symlinkSync(gsd, join(guestHome, ".gsd-path"));
    mkdirSync(join(guestHome, ".config", "gh"), { recursive: true });
    writeFileSync(join(guestHome, ".config", "gh", "hosts.yml"), "x");
    symlinkSync("/elsewhere", join(guestHome, ".aws"));
    const output = mountHome(".gsd-path", gsd, ".config/gh", hostDir(".config/gh"), ".aws", hostDir(".aws"));
    expect(lstatSync(join(guestHome, ".gsd-path")).isDirectory()).toBe(true);
    expect(binds()).toEqual([`mount --bind ${gsd} ${guestHome}/.gsd-path`]);
    expect(output).toContain(`${guestHome}/.config/gh already exists in the sandbox`);
    expect(output).toContain(`${guestHome}/.aws already exists in the sandbox`);
  });

  it("skips targets sbx did not mount", () => {
    mountHome(".gsd-path", join(root, "host", "missing"));
    expect(binds()).toEqual([]);
    expect(existsSync(join(guestHome, ".gsd-path"))).toBe(false);
  });
});
