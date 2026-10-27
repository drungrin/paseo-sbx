import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_LISTEN = "127.0.0.1:6767";

/**
 * Port of Paseo's daemon on the host's loopback, where its MCP server is: sessions that receive
 * the MCP URL inside the provider protocol (Codex) need it relayed before they start. Read from
 * the daemon's config (`daemon.listen`, `host:port` or a port); a unix socket has no MCP URL.
 */
export function daemonPort(env: NodeJS.ProcessEnv = process.env, home = homedir()): number | null {
  let listen = DEFAULT_LISTEN;
  try {
    const config = JSON.parse(readFileSync(join(env.PASEO_HOME || join(home, ".paseo"), "config.json"), "utf8"));
    if (typeof config?.daemon?.listen === "string") listen = config.daemon.listen;
  } catch {
    // no config: the daemon listens on its default
  }
  const match = /^(?:.*:)?(\d{1,5})$/.exec(listen);
  const port = match ? Number(match[1]) : 0;
  return port > 0 && port < 65536 ? port : null;
}
