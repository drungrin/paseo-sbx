import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARSHIP_BUILDS, STARSHIP_VERSION } from "../shared/starship";
import type { PluginPaths } from "./paths";

/**
 * The Sandbox terminal's prompt when you have no `~/.config/starship.toml`: Starship's
 * no-nerd-font preset, so it reads the same on a phone without Nerd Fonts, plus a branch without
 * the Powerline glyph the preset leaves, a marked path cut, and more time for git over the VM's
 * mounts.
 */
export const STARSHIP_CONFIG_SOURCE = `# Written by the paseo-sbx Paseo plugin.
"$schema" = 'https://starship.rs/config-schema.json'
command_timeout = 1000

[directory]
truncation_symbol = "…/"

[git_branch]
symbol = ""

[azure]
symbol = "☁️ "

[battery]
full_symbol = "• "
charging_symbol = "⇡ "
discharging_symbol = "⇣ "
unknown_symbol = "❓ "
empty_symbol = "❗ "

[erlang]
symbol = "ⓔ "

[nodejs]
symbol = "[⬢](bold green) "

[pulumi]
symbol = "🧊 "
`;

export interface StarshipSource {
  url: string;
  sha256: string;
  version: string;
}

/** The pinned build for the VMs, which run on the host's architecture; null where there is none. */
export function starshipSource(arch: string = process.arch): StarshipSource | null {
  const build = STARSHIP_BUILDS[arch];
  if (!build) return null;
  return {
    url: `https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}/starship-${build.target}.tar.gz`,
    sha256: build.sha256,
    version: STARSHIP_VERSION,
  };
}

export interface StarshipStatus {
  enabled: boolean;
  /** The version in the plugin's folder; null when none is. */
  version: string | null;
  installing: boolean;
  error: string | null;
}

const binary = (paths: PluginPaths) => join(paths.binDir, "starship");
const versionFile = (paths: PluginPaths) => join(paths.binDir, "starship.version");

function installedVersion(paths: PluginPaths): string | null {
  try {
    return readFileSync(versionFile(paths), "utf8").trim() || null;
  } catch {
    return null;
  }
}

let installing: Promise<void> | null = null;
let lastError: string | null = null;

export function starshipStatus(paths: PluginPaths, enabled: boolean): StarshipStatus {
  return { enabled, version: installedVersion(paths), installing: installing !== null, error: enabled ? lastError : null };
}

/**
 * Brings the plugin's Starship in line with the setting: downloaded once when it is on (turning
 * it on is your consent), removed when it is off. It lives in the plugin's folder, which every
 * sandbox mounts read-only, so sandboxes need neither a template nor a recreation for it. It only
 * ever runs inside the VMs.
 */
export function syncStarship(
  paths: PluginPaths,
  enabled: boolean,
  source: StarshipSource | null = starshipSource(),
): Promise<void> {
  if (!enabled) {
    lastError = null;
    if (!installing) {
      rmSync(binary(paths), { force: true });
      rmSync(versionFile(paths), { force: true });
    }
    return Promise.resolve();
  }
  if (!source) {
    lastError = `no Starship build for this host's architecture (${process.arch})`;
    return Promise.resolve();
  }
  if (installedVersion(paths) === source.version) return Promise.resolve();
  installing ??= install(paths, source)
    .then(() => {
      lastError = null;
    })
    .catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[paseo-sbx] installing Starship: ${lastError}`);
    })
    .finally(() => {
      installing = null;
    });
  return installing;
}

async function install(paths: PluginPaths, source: StarshipSource): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let data: Buffer;
  try {
    const response = await fetch(source.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`downloading ${source.url}: HTTP ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  const hash = createHash("sha256").update(data).digest("hex");
  if (hash !== source.sha256) throw new Error(`the download of Starship ${source.version} does not match its pinned SHA-256`);
  const dir = mkdtempSync(join(tmpdir(), "paseo-sbx-starship-"));
  try {
    const archive = join(dir, "starship.tar.gz");
    writeFileSync(archive, data);
    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["-xzf", archive, "-C", dir, "starship"], { timeout: 60_000 }, (error) =>
        error ? reject(new Error(`unpacking Starship: ${error.message}`)) : resolve(),
      );
    });
    mkdirSync(paths.binDir, { recursive: true });
    const temp = `${binary(paths)}.${process.pid}.tmp`;
    copyFileSync(join(dir, "starship"), temp);
    chmodSync(temp, 0o755);
    renameSync(temp, binary(paths));
    writeFileSync(versionFile(paths), `${source.version}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function resetStarshipForTests(): void {
  installing = null;
  lastError = null;
}
