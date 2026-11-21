import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { GUEST_KUBECONFIG, KUBE_FILE, kubeSelected } from "../shared/kube";
import type { SandboxSettings } from "../shared/settings";
import type { PluginPaths } from "./paths";
import { runSbx } from "./sbx";

/**
 * Kubernetes contexts from this host's kubeconfig, for a repository's sandboxes. At every session
 * the plugin writes the chosen ones, flattened (certificates inline), into the sandbox's Claude
 * config dir, and the session's `KUBECONFIG` lists it after the sandbox's own `~/.kube/config`.
 * The sandbox's file stays the sandbox's: k3d and `kubectl config` write there, and its current
 * context wins. A cluster on this host is reached at `host.docker.internal`, which follows the
 * host whatever network it is on, and keeps its TLS name.
 */

type Fields = Record<string, unknown>;

/** A kubeconfig as `kubectl config view -o json` prints it. */
export interface KubeDoc {
  "current-context"?: string;
  clusters?: { name: string; cluster: Fields }[] | null;
  users?: { name: string; user: Fields }[] | null;
  contexts?: { name: string; context: Fields }[] | null;
}

export type KubeAuth = "client-certificate" | "token" | "token-file" | "basic" | "exec" | "auth-provider" | "none";

export interface HostContext {
  name: string;
  cluster: string;
  server: string | null;
  /** Where sandboxes reach it: a cluster on this host at `host.docker.internal`, others unchanged. */
  guestServer: string | null;
  /** The namespace the host kubeconfig gives it. */
  namespace: string | null;
  auth: KubeAuth;
  /** Why sandboxes cannot use it; null when they can. */
  unsupported: string | null;
}

export interface GuestKubeconfig {
  config: KubeDoc & { apiVersion: string; kind: string; preferences: Fields };
  contexts: string[];
  /** Chosen contexts left out, with why. */
  skipped: { name: string; reason: string }[];
  /** Ports of the clusters on this host, which the sandbox's network policy allows. */
  hostPorts: number[];
}

export const GUEST_HOST = "host.docker.internal";

const string = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Names that reach this host: loopback, any address, its interfaces' addresses and its name. */
export function localHostnames(): Set<string> {
  const names = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", hostname().toLowerCase()]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) names.add(address.address.toLowerCase());
  }
  return names;
}

function isLocal(host: string, local: ReadonlySet<string>): boolean {
  return local.has(host) || /^127\./.test(host) || host.endsWith(".localhost");
}

/**
 * Where a sandbox reaches a server, and the TLS name it checks the certificate against. A server on
 * this host moves to `host.docker.internal` and keeps its own host as the TLS name: the certificate
 * covers it, since this host's own kubectl checks it with that name.
 */
export function guestServer(server: string, local: ReadonlySet<string>): { server: string; tlsServerName: string | null; hostPort: number | null } {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return { server, tlsServerName: null, hostPort: null };
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!isLocal(host, local)) return { server, tlsServerName: null, hostPort: null };
  const port = Number(url.port) || (url.protocol === "http:" ? 80 : 443);
  const path = url.pathname === "/" ? "" : url.pathname;
  return { server: `${url.protocol}//${GUEST_HOST}:${port}${path}`, tlsServerName: host, hostPort: port };
}

export function authOf(user: Fields | undefined): KubeAuth {
  if (!user) return "none";
  if (user.exec) return "exec";
  if (user["auth-provider"]) return "auth-provider";
  if (string(user["client-certificate-data"]) || string(user["client-certificate"])) return "client-certificate";
  if (string(user.token)) return "token";
  if (string(user.tokenFile)) return "token-file";
  if (string(user.username)) return "basic";
  return "none";
}

function unsupportedAuth(user: Fields | undefined): string | null {
  const exec = user?.exec as { command?: unknown } | undefined;
  if (exec) return `Signs in with ${string(exec.command) ?? "a command"}, which runs on this host`;
  const provider = user?.["auth-provider"] as { name?: unknown } | undefined;
  if (provider) return `Signs in with the ${string(provider.name) ?? ""} auth provider, which runs on this host`.replace("  ", " ");
  return null;
}

function entries<Key extends "clusters" | "users" | "contexts">(doc: KubeDoc, key: Key): NonNullable<KubeDoc[Key]> {
  return (Array.isArray(doc[key]) ? doc[key] : []) as NonNullable<KubeDoc[Key]>;
}

/** The host's contexts, in the kubeconfig's order, with where sandboxes would reach each. */
export function hostContexts(doc: KubeDoc, local: ReadonlySet<string>): HostContext[] {
  const clusters = new Map(entries(doc, "clusters").map((entry) => [entry.name, entry.cluster ?? {}]));
  const users = new Map(entries(doc, "users").map((entry) => [entry.name, entry.user ?? {}]));
  return entries(doc, "contexts").map(({ name, context }) => {
    const clusterName = string(context?.cluster) ?? "";
    const cluster = clusters.get(clusterName);
    const userName = string(context?.user);
    const user = userName ? users.get(userName) : undefined;
    const server = string(cluster?.server);
    const unsupported = !cluster
      ? `Its cluster ${clusterName || "(none)"} is not in the kubeconfig`
      : !server
        ? "Its cluster has no server"
        : userName && !user
          ? `Its user ${userName} is not in the kubeconfig`
          : unsupportedAuth(user);
    return {
      name,
      cluster: clusterName,
      server,
      guestServer: server ? guestServer(server, local).server : null,
      namespace: string(context?.namespace),
      auth: authOf(user),
      unsupported,
    };
  });
}

/**
 * The kubeconfig a sandbox gets: the chosen contexts with their clusters and users, servers on this
 * host moved to `host.docker.internal`, the repository's namespaces, and a current context (the
 * repository's, else the host's, else the first, or none when the repository wants none). A token
 * file is read in, since the guest has none.
 */
export function guestKubeconfig(
  doc: KubeDoc,
  input: {
    names: readonly string[];
    namespaces?: Record<string, string>;
    current?: string | null;
    /** Leaves the current context out, so kubectl without --context fails. */
    noDefault?: boolean;
    local: ReadonlySet<string>;
    readFile?(path: string): string;
  },
): GuestKubeconfig {
  const read = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const contextsByName = new Map(entries(doc, "contexts").map((entry) => [entry.name, entry.context ?? {}]));
  const infos = new Map(hostContexts(doc, input.local).map((info) => [info.name, info]));
  const clustersByName = new Map(entries(doc, "clusters").map((entry) => [entry.name, entry.cluster ?? {}]));
  const usersByName = new Map(entries(doc, "users").map((entry) => [entry.name, entry.user ?? {}]));
  const clusters = new Map<string, Fields>();
  const users = new Map<string, Fields>();
  const contexts: { name: string; context: Fields }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const hostPorts = new Set<number>();
  for (const name of input.names) {
    const info = infos.get(name);
    if (!info) {
      skipped.push({ name, reason: "Not in this host's kubeconfig" });
      continue;
    }
    if (info.unsupported) {
      skipped.push({ name, reason: info.unsupported });
      continue;
    }
    const context: Fields = { ...contextsByName.get(name) };
    const userName = string(context.user);
    if (userName && !users.has(userName)) {
      const user: Fields = { ...usersByName.get(userName) };
      const tokenFile = string(user.tokenFile);
      if (tokenFile && !string(user.token)) {
        try {
          user.token = read(tokenFile).trim();
        } catch (error) {
          skipped.push({ name, reason: `Its token file ${tokenFile} is unreadable: ${error instanceof Error ? error.message : error}` });
          continue;
        }
      }
      delete user.tokenFile;
      users.set(userName, user);
    }
    if (!clusters.has(info.cluster)) {
      const cluster: Fields = { ...clustersByName.get(info.cluster) };
      const moved = guestServer(String(cluster.server), input.local);
      if (moved.hostPort !== null) {
        cluster.server = moved.server;
        if (!string(cluster["tls-server-name"]) && moved.tlsServerName) cluster["tls-server-name"] = moved.tlsServerName;
        hostPorts.add(moved.hostPort);
      }
      clusters.set(info.cluster, cluster);
    }
    const namespace = input.namespaces?.[name]?.trim();
    if (namespace) context.namespace = namespace;
    contexts.push({ name, context });
  }
  const included = contexts.map((entry) => entry.name);
  const hostCurrent = string(doc["current-context"]);
  const current = input.noDefault
    ? undefined
    : ([input.current ?? null, hostCurrent].find((name): name is string => name !== null && included.includes(name)) ??
      included[0]);
  return {
    config: {
      apiVersion: "v1",
      kind: "Config",
      preferences: {},
      ...(current ? { "current-context": current } : {}),
      clusters: [...clusters].map(([name, cluster]) => ({ name, cluster })),
      users: [...users].map(([name, user]) => ({ name, user })),
      contexts,
    },
    contexts: included,
    skipped,
    hostPorts: [...hostPorts].sort((a, b) => a - b),
  };
}

/** The kubeconfig contexts come from: the setting, else the daemon's `KUBECONFIG`, else `~/.kube/config`. */
export function hostKubeconfigPath(settings: Pick<SandboxSettings, "kubeconfig">, env: NodeJS.ProcessEnv, home = homedir()): string {
  const file = settings.kubeconfig.trim();
  if (file === "~" || file.startsWith("~/")) return join(home, file.slice(1));
  return file || env.KUBECONFIG || join(home, ".kube", "config");
}

export interface HostKubeRead {
  file: string;
  doc: KubeDoc | null;
  error: string | null;
}

/**
 * The host kubeconfig, merged and flattened by this host's kubectl (file references inline), so
 * the plugin reads it as JSON. `env` supplies the PATH kubectl is found on.
 */
export function readHostKubeconfig(file: string, env: NodeJS.ProcessEnv = process.env): Promise<HostKubeRead> {
  return new Promise((resolve) => {
    execFile(
      "kubectl",
      ["config", "view", "--raw", "--flatten", "-o", "json"],
      { env: { ...env, KUBECONFIG: file }, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          const message = missing
            ? "kubectl is not on the PATH of Paseo's daemon: the plugin reads the kubeconfig with it"
            : `kubectl could not read ${file}: ${(stderr || error.message).trim()}`;
          resolve({ file, doc: null, error: message });
          return;
        }
        try {
          resolve({ file, doc: JSON.parse(stdout) as KubeDoc, error: null });
        } catch (parseError) {
          resolve({ file, doc: null, error: `kubectl printed no JSON for ${file}: ${parseError instanceof Error ? parseError.message : parseError}` });
        }
      },
    );
  });
}

function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export interface KubeSync {
  /** The file sessions get in `KUBECONFIG`; null when the sandbox gets no contexts. */
  file: string | null;
  contexts: string[];
  skipped: { name: string; reason: string }[];
  hostPorts: number[];
  /** Why the host kubeconfig could not be read: the last file written stays. */
  error: string | null;
}

/** Brings a sandbox's kubeconfig to the repository's choices; removes it when they name none. */
export async function syncKubeconfig(input: {
  settings: SandboxSettings;
  repoKey: string;
  claudeConfigDir: string;
  env: NodeJS.ProcessEnv;
  home: string;
  local?: ReadonlySet<string>;
}): Promise<KubeSync> {
  const target = join(input.claudeConfigDir, KUBE_FILE);
  const names = kubeSelected(input.settings, input.repoKey);
  if (names.length === 0) {
    rmSync(target, { force: true });
    return { file: null, contexts: [], skipped: [], hostPorts: [], error: null };
  }
  const read = await readHostKubeconfig(hostKubeconfigPath(input.settings, input.env, input.home), input.env);
  if (!read.doc) {
    const kept = guestKubeFile(input.claudeConfigDir);
    return { file: kept ? target : null, contexts: kept?.contexts ?? [], skipped: [], hostPorts: [], error: read.error };
  }
  const repo = input.settings.repos[input.repoKey];
  const built = guestKubeconfig(read.doc, {
    names,
    namespaces: repo?.kubeNamespaces,
    current: repo?.kubeCurrent ?? null,
    noDefault: repo?.kubeNoDefault ?? false,
    local: input.local ?? localHostnames(),
  });
  if (built.contexts.length === 0) {
    rmSync(target, { force: true });
    return { file: null, contexts: [], skipped: built.skipped, hostPorts: [], error: null };
  }
  writeAtomic(target, `${JSON.stringify(built.config, null, 2)}\n`);
  return { file: target, contexts: built.contexts, skipped: built.skipped, hostPorts: built.hostPorts, error: null };
}

export interface GuestKubeFile {
  contexts: string[];
  /** Each context's namespace, when it has one. */
  namespaces: Record<string, string>;
  current: string | null;
  writtenAt: number;
}

/** What the sandbox's kubeconfig holds now, as the plugin last wrote it; null without one. */
export function guestKubeFile(claudeConfigDir: string): GuestKubeFile | null {
  const file = join(claudeConfigDir, KUBE_FILE);
  try {
    const writtenAt = statSync(file).mtimeMs;
    const doc = JSON.parse(readFileSync(file, "utf8")) as KubeDoc;
    const contexts = entries(doc, "contexts");
    const namespaces: Record<string, string> = {};
    for (const entry of contexts) {
      const namespace = string(entry.context?.namespace);
      if (namespace) namespaces[entry.name] = namespace;
    }
    return { contexts: contexts.map((entry) => entry.name), namespaces, current: string(doc["current-context"]), writtenAt };
  } catch {
    return null;
  }
}

/**
 * Runs in the sandbox (python3, which the plugin needs there anyway): the kubectl it has, the
 * contexts of its own kubeconfig, and a call to each context of the plugin's, with the session's
 * `KUBECONFIG`. Without kubectl it asks `/version` itself, with the plugin's file.
 */
export const KUBE_TEST_SOURCE = String.raw`
import base64, json, os, shutil, socket, ssl, subprocess, sys, tempfile
from urllib.parse import urlsplit

own_path, plugin_path = sys.argv[1], sys.argv[2]
out = {"kubectl": None, "own": None, "ownCurrent": None, "current": None, "results": [], "error": None}
env = dict(os.environ, KUBECONFIG=own_path + ":" + plugin_path)
kubectl = shutil.which("kubectl")

def run(args, kubeconfig=None):
    run_env = env if kubeconfig is None else dict(os.environ, KUBECONFIG=kubeconfig)
    return subprocess.run([kubectl] + args, capture_output=True, text=True, timeout=20, env=run_env)

def last_line(text, code):
    lines = [line for line in (text or "").strip().splitlines() if line.strip()]
    return lines[-1][:300] if lines else "exit %d" % code

def probe(doc, context):
    ctx = context.get("context", {})
    cluster = next((c["cluster"] for c in doc.get("clusters") or [] if c["name"] == ctx.get("cluster")), {})
    user = next((u["user"] for u in doc.get("users") or [] if u["name"] == ctx.get("user")), {})
    url = urlsplit(cluster.get("server", ""))
    tls = ssl.create_default_context()
    if cluster.get("insecure-skip-tls-verify"):
        tls.check_hostname = False
        tls.verify_mode = ssl.CERT_NONE
    elif cluster.get("certificate-authority-data"):
        tls.load_verify_locations(cadata=base64.b64decode(cluster["certificate-authority-data"]).decode())
    folder = tempfile.mkdtemp()
    try:
        if user.get("client-certificate-data"):
            cert, key = os.path.join(folder, "cert"), os.path.join(folder, "key")
            for path, field in ((cert, "client-certificate-data"), (key, "client-key-data")):
                with open(os.open(path, os.O_WRONLY | os.O_CREAT, 0o600), "wb") as handle:
                    handle.write(base64.b64decode(user.get(field, "")))
            tls.load_cert_chain(cert, key)
        sock = socket.create_connection((url.hostname, url.port or 443), timeout=8)
        conn = tls.wrap_socket(sock, server_hostname=cluster.get("tls-server-name") or url.hostname)
        request = "GET /version HTTP/1.1\r\nHost: %s\r\nAccept: application/json\r\nConnection: close\r\n" % url.netloc
        if user.get("token"):
            request += "Authorization: Bearer %s\r\n" % user["token"]
        elif user.get("username"):
            pair = "%s:%s" % (user["username"], user.get("password", ""))
            request += "Authorization: Basic %s\r\n" % base64.b64encode(pair.encode()).decode()
        conn.sendall((request + "\r\n").encode())
        data = b""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            data += chunk
        conn.close()
        head, _, body = data.partition(b"\r\n\r\n")
        status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        if " 200 " not in status + " ":
            return False, status
        try:
            return True, json.loads(body.decode(errors="replace")).get("gitVersion") or status
        except ValueError:
            return True, status
    except Exception as error:
        return False, str(error)[:300]
    finally:
        shutil.rmtree(folder, ignore_errors=True)

try:
    with open(plugin_path) as handle:
        plugin = json.load(handle)
except Exception:
    plugin = None
    out["error"] = "no-file"

if kubectl:
    version = run(["version", "--client", "-o", "json"])
    try:
        out["kubectl"] = json.loads(version.stdout)["clientVersion"]["gitVersion"]
    except Exception:
        out["kubectl"] = "unknown"
    if os.path.exists(own_path):
        names = run(["config", "get-contexts", "-o", "name"], own_path)
        out["own"] = [name for name in names.stdout.split() if name] if names.returncode == 0 else []
        current = run(["config", "current-context"], own_path)
        out["ownCurrent"] = current.stdout.strip() or None if current.returncode == 0 else None
    else:
        out["own"] = []
    current = run(["config", "current-context"])
    out["current"] = current.stdout.strip() or None if current.returncode == 0 else None

for context in (plugin or {}).get("contexts") or []:
    name = context["name"]
    if kubectl:
        result = run(["--context", name, "version", "-o", "json", "--request-timeout=8s"])
        server = None
        try:
            server = json.loads(result.stdout).get("serverVersion", {}).get("gitVersion")
        except Exception:
            pass
        ok = result.returncode == 0 and server is not None
        detail = server if ok else last_line(result.stderr, result.returncode)
    else:
        ok, detail = probe(plugin, context)
    out["results"].append({"context": name, "ok": ok, "detail": detail})

print(json.dumps(out))
`;

export interface KubeTest {
  /** The guest's kubectl version; null without one. */
  kubectl: string | null;
  /** Contexts of the sandbox's own kubeconfig; null when there is no kubectl to read it. */
  own: string[] | null;
  ownCurrent: string | null;
  /** The context sessions use, the sandbox's own and the plugin's together; null without kubectl. */
  current: string | null;
  results: { context: string; ok: boolean; detail: string }[];
  /** "no-file" before the plugin wrote the sandbox's kubeconfig. */
  error: string | null;
}

/** Tries each context of the plugin's kubeconfig from inside a running sandbox. */
export async function testKube(paths: PluginPaths, name: string, claudeConfigDir: string): Promise<KubeTest> {
  const result = await runSbx(
    paths,
    ["exec", name, "python3", "-c", KUBE_TEST_SOURCE, GUEST_KUBECONFIG, join(claudeConfigDir, KUBE_FILE)],
    25_000,
  );
  if (result.code !== 0) throw new Error(`testing in ${name} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  const line = result.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(line) as KubeTest;
}
