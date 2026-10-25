// Files the plugin writes to its bin dir. The server bundle is evaluated without access to the
// plugin's own directory, so the wrapper ships as source and is materialized at startup.
// WRAPPER_SOURCE must not contain backticks or dollar-brace sequences (String.raw literal).

/**
 * Provider command for `claude-sbx`. Paseo spawns it with cwd = agent cwd and the Claude Agent
 * SDK arguments. It runs the host's Claude Code binary inside the sandbox named by the plugin's
 * PASEO_SBX_SPEC, and fails closed without one: only Paseo's catalogue probe runs on the host.
 */
export const WRAPPER_SOURCE = String.raw`'use strict';
// Written by the paseo-sbx Paseo plugin. Do not edit: the plugin rewrites it on startup.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SPEC_ENV = 'PASEO_SBX_SPEC';
const ENSURE_FLAG = '--paseo-sbx-ensure';
const FORWARDED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'PASEO_', 'MCP_', 'DISABLE_'];
const FORWARDED_NAMES = ['API_TIMEOUT_MS', 'MAX_THINKING_TOKENS', 'LANG', 'TZ'];
// Host paths or plugin plumbing that mean nothing inside the VM.
const HOST_ONLY = new Set([SPEC_ENV, 'PASEO_HOME', 'CLAUDE_ENV_FILE', 'CLAUDE_CONFIG_DIR']);
const args = process.argv.slice(2);

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
  if (result.error) fail('sbx ' + sbxArgs[0] + ': ' + result.error.message);
  return result;
}

function sbxOk(spec, sbxArgs, what) {
  const result = sbx(spec, sbxArgs);
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || '').trim();
    fail(what + ' failed (exit ' + result.status + '): ' + output.slice(-800));
  }
  return result.stdout;
}

function withLock(lockDir, fn) {
  const deadline = Date.now() + 180000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 600000) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch (statError) {
        // released between the attempts
      }
      if (Date.now() > deadline) fail('timed out waiting for ' + lockDir);
      sleep(200);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch (error) {
      // already gone
    }
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

function ensureSandbox(spec, claudeDir) {
  fs.mkdirSync(spec.locksDir, { recursive: true });
  fs.mkdirSync(spec.claudeConfigDir, { recursive: true });
  withLock(path.join(spec.locksDir, spec.name), function () {
    const list = JSON.parse(sbxOk(spec, ['ls', '--json'], 'sbx ls') || '[]');
    if (list.some(function (sandbox) { return sandbox.name === spec.name; })) return;
    const seen = new Set([spec.workspace]);
    const mounts = [spec.workspace];
    const extra = spec.mounts.concat([claudeDir + ':ro', spec.binDir + ':ro', spec.claudeConfigDir]);
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
  const pattern = /(?:127\.0\.0\.1|localhost):(\d+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) into.add(Number(match[1]));
}

// Loopback services the session talks to: Paseo's MCP server (--mcp-config), the API base URL
// from the environment, and anything the shared Claude settings point at.
function detectPorts(spec) {
  const ports = new Set(spec.forwardPorts);
  args.forEach(function (arg, index) {
    if (arg === '--mcp-config') collectLoopbackPorts(args[index + 1] || '', ports);
  });
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('ANTHROPIC_')) collectLoopbackPorts(process.env[name] || '', ports);
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

function ensurePolicy(spec, ports) {
  withLock(path.join(spec.locksDir, spec.name), function () {
    const state = readState(spec);
    const applied = new Set(state.policies || []);
    const wanted = spec.networkAllow.concat(ports.map(function (port) { return 'localhost:' + port; }));
    const missing = wanted.filter(function (rule) { return !applied.has(rule); });
    if (missing.length === 0) return;
    sbxOk(spec, ['policy', 'allow', 'network', '--sandbox', spec.name, missing.join(',')], 'sbx policy allow');
    state.policies = Array.from(applied).concat(missing);
    writeState(spec, state);
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

function forwardedEnvNames(env, spec) {
  const names = [];
  for (const name of Object.keys(env)) {
    if (HOST_ONLY.has(name) || env[name] === undefined) continue;
    if (FORWARDED_NAMES.includes(name) || FORWARDED_PREFIXES.some(function (prefix) { return name.startsWith(prefix); })) {
      names.push(name);
    }
  }
  return names.concat(Object.keys(spec.env), ['CLAUDE_CONFIG_DIR', 'PASEO_SBX_SANDBOX']);
}

function relaySignals(onSignal) {
  let relayed = false;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, function () {
      if (relayed) return;
      relayed = true;
      onSignal();
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

// Values travel in the sbx client's environment and only the names on its command line,
// so tokens never show up in the host process list.
function runInSandbox(spec, claude) {
  const pidfile = '/tmp/paseo-sbx-' + process.pid + '-' + Date.now() + '.pid';
  const env = Object.assign(sbxEnv(spec), spec.env, {
    CLAUDE_CONFIG_DIR: spec.claudeConfigDir,
    PASEO_SBX_SANDBOX: spec.name,
  });
  const envArgs = [];
  for (const name of forwardedEnvNames(env, spec)) envArgs.push('-e', name);
  const execArgs = ['exec', '-i', '-w', process.cwd()].concat(envArgs, [
    spec.name, 'sh', '-c', 'echo $$ > "$0"; exec "$@"', pidfile, claude,
  ], args);
  const child = cp.spawn('sbx', execArgs, { stdio: 'inherit', env: env });
  // Killing the sbx exec client leaves the guest process running, though it closes the guest
  // stdin, which ends stream-json input. TERM the guest process too, inside the daemon's
  // 2 s grace period.
  relaySignals(function () {
    child.kill('SIGTERM');
    cp.spawnSync('timeout', ['1.5', 'sbx', 'exec', spec.name, 'sh', '-c', 'kill -TERM "$(cat "$0")" 2>/dev/null; rm -f "$0"', pidfile], {
      stdio: 'ignore',
      env: sbxEnv(spec),
    });
  });
  child.on('exit', exitLikeChild);
}

function readSpec() {
  const raw = process.env[SPEC_ENV];
  if (!raw) return null;
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (error) {
    fail('invalid ' + SPEC_ENV + ': ' + error.message);
  }
  if (spec.version !== 1) fail('unsupported ' + SPEC_ENV + ' version ' + spec.version);
  return spec;
}

function main() {
  const claude = findClaude();
  if (!claude) fail('claude was not found on PATH');
  const spec = readSpec();
  if (!spec) {
    if (isCatalogProbe()) return runOnHost(claude);
    fail('missing ' + SPEC_ENV + ': claude-sbx sessions need the paseo-sbx plugin enabled');
  }
  ensureSandbox(spec, path.dirname(claude));
  const ports = detectPorts(spec);
  ensurePolicy(spec, ports);
  if (args[0] === ENSURE_FLAG) return;
  ensureForwarder(spec, ports);
  log('sandbox=' + spec.name + ' cwd=' + process.cwd() + ' claude=' + claude);
  runInSandbox(spec, claude);
}

main();
`;

/** Relays each guest loopback port to the same port on the host. */
export const FORWARDER_SOURCE = String.raw`# Written by the paseo-sbx Paseo plugin.
# Relays 127.0.0.1:<port> in the sandbox to host.docker.internal:<port>. Ports are
# independent; the process exits only when none could be bound.
import asyncio, sys

async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        writer.close()

async def serve(port):
    async def handle(client_reader, client_writer):
        try:
            host_reader, host_writer = await asyncio.open_connection("host.docker.internal", port)
        except OSError as error:
            print(f"port {port}: upstream connect failed: {error}", file=sys.stderr, flush=True)
            client_writer.close()
            return
        await asyncio.gather(pipe(client_reader, host_writer), pipe(host_reader, client_writer))
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
