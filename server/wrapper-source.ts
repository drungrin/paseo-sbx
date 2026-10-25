// Files the plugin writes to its bin dir. The server bundle is evaluated without access to the
// plugin's own directory, so these ship as source and are materialized at startup.
// The String.raw literals must not contain backticks or dollar-brace sequences.

/**
 * Provider command for `claude-sbx`, started through the shell launcher (see `launcherSource`).
 * Paseo spawns it with cwd = agent cwd and the Claude Agent SDK arguments. It runs the host's
 * Claude Code binary inside the sandbox named by the plugin's PASEO_SBX_SPEC and fails closed
 * without one: only Paseo's catalogue probe and version queries run on the host.
 */
export const WRAPPER_SOURCE = String.raw`'use strict';
// Written by the paseo-sbx Paseo plugin. Do not edit: the plugin rewrites it on startup.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Set by the launcher so an Electron-hosted daemon runs us as Node; nothing below needs it.
delete process.env.ELECTRON_RUN_AS_NODE;

const SPEC_ENV = 'PASEO_SBX_SPEC';
const ENSURE_FLAG = '--paseo-sbx-ensure';
const FORWARDED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'PASEO_', 'MCP_', 'DISABLE_'];
const FORWARDED_NAMES = ['API_TIMEOUT_MS', 'MAX_THINKING_TOKENS', 'LANG', 'TZ'];
// Host paths or plugin plumbing that mean nothing inside the VM.
const HOST_ONLY = new Set([SPEC_ENV, 'PASEO_HOME', 'CLAUDE_ENV_FILE', 'CLAUDE_CONFIG_DIR']);
// The sbx client reads these itself; a forwarded value would redirect the host-side client.
const RESERVED = new Set(['PATH', 'HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS']);
const RESERVED_PREFIXES = ['SBX_', 'DOCKER_'];
const SYSTEM_DIRS = new Set(['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/local/bin', '/usr/local/sbin']);
const args = process.argv.slice(2);

class WrapperError extends Error {}

function log(message) {
  process.stderr.write('[paseo-sbx] ' + message + '\n');
}

function fail(message) {
  log(message);
  process.exit(1);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isReserved(name) {
  return RESERVED.has(name) || RESERVED_PREFIXES.some(function (prefix) { return name.startsWith(prefix); });
}

function findClaude() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch (error) {
      // keep looking
    }
  }
  return null;
}

// Paseo's model catalogue probe: no session (so no spec), started from $HOME with user
// settings only, no tools, no MCP servers and no persisted session.
function isCatalogProbe() {
  const tools = args.indexOf('--tools');
  return (
    process.cwd() === os.homedir() &&
    args.includes('--setting-sources=user') &&
    args.includes('--strict-mcp-config') &&
    args.includes('--no-session-persistence') &&
    tools >= 0 &&
    args[tools + 1] === ''
  );
}

// Paseo's provider diagnostic asks the command for its version.
function isInfoCommand() {
  return args.length === 1 && ['--version', '-v', '--help', '-h'].includes(args[0]);
}

function sbxEnv(spec) {
  return Object.assign({}, process.env, { XDG_STATE_HOME: spec.stateHome });
}

// Auxiliary sbx calls never inherit stdin: an sbx exec without -i still drains it, which
// would swallow the SDK's first stream-json message.
function sbx(spec, sbxArgs) {
  const result = cp.spawnSync('sbx', sbxArgs, {
    env: sbxEnv(spec),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 600000,
  });
  if (result.error) throw new WrapperError('sbx ' + sbxArgs[0] + ': ' + result.error.message);
  return result;
}

function sbxOk(spec, sbxArgs, what) {
  const result = sbx(spec, sbxArgs);
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || '').trim();
    throw new WrapperError(what + ' failed (exit ' + result.status + '): ' + output.slice(-800));
  }
  return result.stdout;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// mkdir lock with an owner file: a lock whose owner died is taken over at once, and errors
// thrown inside fn release it on the way out.
function withLock(lockDir, fn) {
  const owner = path.join(lockDir, 'owner');
  const deadline = Date.now() + 180000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(owner, String(process.pid));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ownerPid = 0;
      try {
        ownerPid = Number(fs.readFileSync(owner, 'utf8'));
      } catch (readError) {
        // owner not written yet, or released between the attempts
      }
      let stale = ownerPid > 0 && !processAlive(ownerPid);
      try {
        stale = stale || Date.now() - fs.statSync(lockDir).mtimeMs > 600000;
      } catch (statError) {
        continue;
      }
      if (stale) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new WrapperError('timed out waiting for ' + lockDir);
      sleep(200);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function statePath(spec) {
  return path.join(spec.stateDir, spec.name + '.json');
}

function readState(spec) {
  try {
    return JSON.parse(fs.readFileSync(statePath(spec), 'utf8'));
  } catch (error) {
    return {};
  }
}

function writeState(spec, state) {
  fs.mkdirSync(spec.stateDir, { recursive: true });
  fs.writeFileSync(statePath(spec), JSON.stringify(state, null, 2) + '\n');
}

function mountPath(entry) {
  return entry.endsWith(':ro') ? entry.slice(0, -3) : entry;
}

// The host binary reaches the guest through a read-only mount of its directory, so Claude
// updates show up in place. A system directory would shadow the guest's own, so mount only
// the binary there.
function claudeMount(claude) {
  const dir = path.dirname(claude);
  return (SYSTEM_DIRS.has(dir) ? claude : dir) + ':ro';
}

function ensureSandbox(spec, claude) {
  fs.mkdirSync(spec.locksDir, { recursive: true });
  fs.mkdirSync(spec.claudeConfigDir, { recursive: true });
  withLock(path.join(spec.locksDir, spec.name), function () {
    const list = JSON.parse(sbxOk(spec, ['ls', '--json'], 'sbx ls') || '[]');
    if (list.some(function (sandbox) { return sandbox.name === spec.name; })) return;
    const seen = new Set([spec.workspace]);
    const mounts = [spec.workspace];
    const extra = spec.mounts.concat([claudeMount(claude), spec.binDir + ':ro', spec.claudeConfigDir]);
    for (const entry of extra) {
      const target = mountPath(entry);
      if (seen.has(target)) continue;
      if (!fs.existsSync(target)) {
        log('skipping missing mount ' + target);
        continue;
      }
      seen.add(target);
      mounts.push(entry);
    }
    const createArgs = ['create', '--name', spec.name, '--memory', spec.memory, '--no-progress'];
    if (spec.cpus > 0) createArgs.push('--cpus', String(spec.cpus));
    sbxOk(spec, createArgs.concat(['claude'], mounts), 'sbx create ' + spec.name);
    writeState(spec, { key: spec.key, workspace: spec.workspace, policies: [] });
    log('created sandbox ' + spec.name + ' (' + spec.memory + ')');
  });
}

function collectLoopbackPorts(text, into) {
  const pattern = /(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) into.add(Number(match[1]));
}

// Loopback services the session talks to: Paseo's MCP server (--mcp-config), API base URLs in
// the session environment (including forwarded variables), and anything the shared Claude
// settings point at.
function detectPorts(spec, env) {
  const ports = new Set(spec.forwardPorts);
  args.forEach(function (arg, index) {
    if (arg === '--mcp-config') collectLoopbackPorts(args[index + 1] || '', ports);
  });
  for (const name of Object.keys(env)) {
    if (name.startsWith('ANTHROPIC_')) collectLoopbackPorts(env[name] || '', ports);
  }
  try {
    collectLoopbackPorts(fs.readFileSync(path.join(spec.claudeConfigDir, 'settings.json'), 'utf8'), ports);
  } catch (error) {
    // no shared settings
  }
  return Array.from(ports)
    .filter(function (port) { return port > 0 && port < 65536; })
    .sort(function (a, b) { return a - b; });
}

// Reconciles the sandbox's network rules with the spec, revoking rules it no longer lists.
function ensurePolicy(spec, ports) {
  withLock(path.join(spec.locksDir, spec.name), function () {
    const state = readState(spec);
    const applied = new Set(state.policies || []);
    const wanted = new Set(spec.networkAllow.concat(ports.map(function (port) { return 'localhost:' + port; })));
    const missing = Array.from(wanted).filter(function (rule) { return !applied.has(rule); });
    const stale = Array.from(applied).filter(function (rule) { return !wanted.has(rule); });
    if (missing.length > 0) {
      sbxOk(spec, ['policy', 'allow', 'network', '--sandbox', spec.name, missing.join(',')], 'sbx policy allow');
    }
    for (const rule of stale) {
      sbxOk(spec, ['policy', 'rm', 'network', '--sandbox', spec.name, '--resource', rule], 'sbx policy rm ' + rule);
    }
    if (missing.length > 0 || stale.length > 0) {
      state.policies = Array.from(wanted);
      writeState(spec, state);
    }
  });
}

// Guest loopback ports relay to host.docker.internal, so URLs keep their 127.0.0.1 form.
// The VM stops 30 s after its last session and takes the relay with it: ensure it per launch.
function ensureForwarder(spec, ports) {
  if (ports.length === 0) return;
  const script = [
    'dir=$0',
    'missing=$(python3 "$dir/wait-ports.py" --missing $1)',
    '[ -z "$missing" ] && exit 0',
    'nohup python3 "$dir/loopback-forward.py" $missing >>/tmp/paseo-sbx-forward.log 2>&1 &',
    'python3 "$dir/wait-ports.py" --wait $missing',
  ].join('\n');
  sbxOk(spec, ['exec', spec.name, 'sh', '-c', script, spec.binDir, ports.join(' ')], 'loopback forwarder');
}

function sessionEnv(spec) {
  const env = Object.assign(sbxEnv(spec), {
    CLAUDE_CONFIG_DIR: spec.claudeConfigDir,
    PASEO_SBX_SANDBOX: spec.name,
  });
  for (const name of Object.keys(spec.env)) {
    if (isReserved(name)) log('not forwarding reserved variable ' + name);
    else env[name] = spec.env[name];
  }
  return env;
}

function forwardedEnvNames(env, spec) {
  const names = new Set(['CLAUDE_CONFIG_DIR', 'PASEO_SBX_SANDBOX']);
  for (const name of Object.keys(env)) {
    if (HOST_ONLY.has(name) || isReserved(name) || env[name] === undefined) continue;
    if (FORWARDED_NAMES.includes(name) || FORWARDED_PREFIXES.some(function (prefix) { return name.startsWith(prefix); })) {
      names.add(name);
    }
  }
  for (const name of Object.keys(spec.env)) {
    if (!isReserved(name)) names.add(name);
  }
  return Array.from(names);
}

function relaySignals(onSignal) {
  let relayed = false;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, function () {
      if (relayed) return;
      relayed = true;
      onSignal(signal);
    });
  }
}

function exitLikeChild(code) {
  process.exit(code === null ? 1 : code);
}

function runOnHost(claude) {
  const child = cp.spawn(claude, args, { stdio: 'inherit' });
  relaySignals(function () { child.kill('SIGTERM'); });
  child.on('exit', exitLikeChild);
}

// Values travel in the sbx client's environment and only the names on its command line, so
// tokens never show up in the host process list.
//
// Session teardown happens in the guest. Whatever ends the session on the host (stdin closed,
// the client killed by any signal, the daemon tree-killing us), the guest's stdin reaches EOF
// and guest-supervisor.py stops Claude's process tree there. Host-side cleanup cannot do this
// reliably: the daemon tree-kills any process we spawn while it shuts us down.
function runInSandbox(spec, claude, env) {
  const envArgs = [];
  for (const name of forwardedEnvNames(env, spec)) envArgs.push('-e', name);
  const execArgs = ['exec', '-i', '-w', process.cwd()].concat(envArgs, [
    spec.name, 'python3', path.join(spec.binDir, 'guest-supervisor.py'), claude,
  ], args);
  const child = cp.spawn('sbx', execArgs, { stdio: 'inherit', env: env });
  relaySignals(function () { child.kill('SIGTERM'); });
  child.on('exit', exitLikeChild);
}

function readSpec() {
  const raw = process.env[SPEC_ENV];
  if (!raw) return null;
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (error) {
    throw new WrapperError('invalid ' + SPEC_ENV + ': ' + error.message);
  }
  if (spec.version !== 1) throw new WrapperError('unsupported ' + SPEC_ENV + ' version ' + spec.version);
  return spec;
}

function main() {
  const claude = findClaude();
  if (!claude) throw new WrapperError('claude was not found on PATH');
  const spec = readSpec();
  if (!spec) {
    if (isCatalogProbe() || isInfoCommand()) return runOnHost(claude);
    // A probe whose argv changed with an SDK update lands here too: say what we got.
    throw new WrapperError(
      'missing ' + SPEC_ENV + ': claude-sbx sessions need the paseo-sbx plugin enabled (cwd ' +
        process.cwd() + ', args ' + JSON.stringify(args.slice(0, 12)) + ')',
    );
  }
  const env = sessionEnv(spec);
  ensureSandbox(spec, claude);
  const ports = detectPorts(spec, env);
  ensurePolicy(spec, ports);
  if (args[0] === ENSURE_FLAG) return;
  ensureForwarder(spec, ports);
  log('sandbox=' + spec.name + ' cwd=' + process.cwd() + ' claude=' + claude);
  runInSandbox(spec, claude, env);
}

try {
  main();
} catch (error) {
  fail(error instanceof WrapperError ? error.message : (error && error.stack) || String(error));
}
`;

/** Shell launcher registered as the provider command; restores Node mode for Electron hosts. */
export function launcherSource(nodeBinary: string, wrapperPath: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# Written by the paseo-sbx Paseo plugin. Do not edit: the plugin rewrites it on startup.",
    "# The daemon may run inside Electron, whose binary acts as Node only with this variable.",
    `ELECTRON_RUN_AS_NODE=1 exec ${quote(nodeBinary)} ${quote(wrapperPath)} "$@"`,
    "",
  ].join("\n");
}

/** Relays each guest loopback port to the same port on the host. */
export const FORWARDER_SOURCE = String.raw`# Written by the paseo-sbx Paseo plugin.
# Relays 127.0.0.1:<port> (and ::1 when available) in the sandbox to host.docker.internal:<port>.
# Ports are independent; the process exits only when none could be bound.
import asyncio, socket, sys

async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass

async def serve(port):
    async def handle(client_reader, client_writer):
        try:
            host_reader, host_writer = await asyncio.open_connection("host.docker.internal", port)
        except OSError as error:
            print(f"port {port}: upstream connect failed: {error}", file=sys.stderr, flush=True)
            client_writer.close()
            return
        await asyncio.gather(pipe(client_reader, host_writer), pipe(host_reader, client_writer))
    hosts = ["127.0.0.1", "::1"] if socket.has_ipv6 else ["127.0.0.1"]
    try:
        server = await asyncio.start_server(handle, hosts, port)
    except OSError:
        try:
            server = await asyncio.start_server(handle, "127.0.0.1", port)
        except OSError as error:
            print(f"port {port}: bind failed: {error}", file=sys.stderr, flush=True)
            return False
    async with server:
        await server.serve_forever()

async def main():
    results = await asyncio.gather(*(serve(int(port)) for port in sys.argv[1:]))
    if not any(result is not False for result in results):
        sys.exit(1)

asyncio.run(main())
`;

/** `--missing PORT...` prints the ports nothing listens on; `--wait PORT...` waits up to 3 s. */
export const WAIT_PORTS_SOURCE = String.raw`# Written by the paseo-sbx Paseo plugin.
import socket, sys, time

mode, ports = sys.argv[1], [int(port) for port in sys.argv[2:]]

def listening(port):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
        return True
    except OSError:
        return False

if mode == "--missing":
    print(" ".join(str(port) for port in ports if not listening(port)))
else:
    deadline = time.monotonic() + 3
    pending = list(ports)
    while pending and time.monotonic() < deadline:
        pending = [port for port in pending if not listening(port)]
        if pending:
            time.sleep(0.05)
    if pending:
        sys.exit("forwarder not listening on " + " ".join(str(port) for port in pending))
`;

/**
 * Runs Claude Code in the sandbox and owns its teardown. Claude gets its own process group and
 * a stdin pipe fed from ours. When our stdin reaches EOF (the session ended, or the host side
 * went away by any means), Claude gets PASEO_SBX_STOP_GRACE seconds to end its session, then
 * its process tree is terminated. Every exit path ends with the cleanup, on the main thread.
 */
export const SUPERVISOR_SOURCE = String.raw`# Written by the paseo-sbx Paseo plugin.
import os, signal, subprocess, sys, threading, time

GRACE = float(os.environ.get("PASEO_SBX_STOP_GRACE", "5"))

child = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, start_new_session=True)
# pid -> start time of every process seen under Claude. Tools may run in their own process
# groups and are reparented once Claude exits, so they are tracked while Claude still owns them;
# the start time guards against killing a reused pid.
known = {}
known_lock = threading.Lock()
eof = threading.Event()


def scan():
    children, starts = {}, {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as stat:
                fields = stat.read().rsplit(")", 1)[1].split()
            pid = int(entry)
            children.setdefault(int(fields[1]), []).append(pid)
            starts[pid] = fields[19]
        except (OSError, IndexError, ValueError):
            pass
    return children, starts


def remember_tree():
    children, starts = scan()
    pending = [child.pid]
    with known_lock:
        while pending:
            for kid in children.get(pending.pop(), []):
                if kid in starts:
                    known[kid] = starts[kid]
                pending.append(kid)


def signal_known(sig):
    _, starts = scan()
    with known_lock:
        targets = [pid for pid, start in known.items() if starts.get(pid) == start]
    for pid in targets:
        try:
            os.kill(pid, sig)
        except OSError:
            pass
    return targets


def track():
    while child.poll() is None:
        remember_tree()
        time.sleep(1)


def wait_for_child(seconds):
    deadline = time.monotonic() + seconds
    while child.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)


def pump():
    try:
        while True:
            chunk = os.read(0, 65536)
            if not chunk:
                break
            child.stdin.write(chunk)
            child.stdin.flush()
    except OSError:
        pass
    eof.set()
    remember_tree()
    try:
        child.stdin.close()
    except OSError:
        pass
    # Claude ends its session on stdin EOF; a running tool call can hold it up.
    wait_for_child(GRACE)
    if child.poll() is None:
        remember_tree()
        try:
            os.kill(child.pid, signal.SIGTERM)
        except OSError:
            pass
        signal_known(signal.SIGTERM)
        wait_for_child(1)
        if child.poll() is None:
            try:
                os.kill(child.pid, signal.SIGKILL)
            except OSError:
                pass


def forward(number, frame):
    remember_tree()
    try:
        os.kill(child.pid, number)
    except OSError:
        pass
    signal_known(number)


def cleanup():
    # Whatever Claude left behind: TERM, a short wait, then KILL for anything still running.
    if signal_known(signal.SIGTERM):
        time.sleep(0.5)
        signal_known(signal.SIGKILL)
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except OSError:
        pass


threading.Thread(target=pump, daemon=True).start()
threading.Thread(target=track, daemon=True).start()
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, forward)
code = child.wait()
cleanup()
sys.exit(128 - code if code < 0 else code)
`;
