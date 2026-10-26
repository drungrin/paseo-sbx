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
const SPEC_VERSION = 2;
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

// Paseo's provider diagnostic asks the command for its version and login state.
const INFO_COMMANDS = [['--version'], ['-v'], ['--help'], ['-h'], ['auth', 'status']];

function isInfoCommand() {
  return INFO_COMMANDS.some(function (command) {
    return command.length === args.length && command.every(function (arg, index) { return args[index] === arg; });
  });
}

function isSessionValue(name, spec) {
  return (
    name === SPEC_ENV ||
    HOST_ONLY.has(name) ||
    Object.prototype.hasOwnProperty.call(spec.env, name) ||
    FORWARDED_NAMES.includes(name) ||
    FORWARDED_PREFIXES.some(function (prefix) { return name.startsWith(prefix); })
  );
}

// Environment of every sbx client process, exec included: the daemon's own variables (PATH,
// D-Bus, proxies, certificates) without anything that belongs to the session. Whichever call
// finds the sandbox daemon stopped starts it, and the daemon keeps that environment.
function managementEnv(spec) {
  const env = {};
  for (const name of Object.keys(process.env)) {
    if (!isSessionValue(name, spec)) env[name] = process.env[name];
  }
  env.XDG_STATE_HOME = spec.stateHome;
  return env;
}

const SIGN_IN_PATTERN = /keychain[^\n]*locked|keyring[^\n]*locked|not signed in/i;

function sbxFailure(what, status, output) {
  const hint = SIGN_IN_PATTERN.test(output)
    ? ' (sbx cannot read its login: unlock the OS keyring, or use one without a password, and run sbx login)'
    : '';
  return new WrapperError(what + ' failed (exit ' + status + ')' + hint + ': ' + output.slice(-800));
}

// Auxiliary sbx calls never inherit stdin: an sbx exec without -i still drains it, which
// would swallow the SDK's first stream-json message.
function sbx(spec, sbxArgs) {
  const result = cp.spawnSync('sbx', sbxArgs, {
    env: managementEnv(spec),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 600000,
  });
  if (result.error) throw new WrapperError('sbx ' + sbxArgs[0] + ': ' + result.error.message);
  return result;
}

function sbxOk(spec, sbxArgs, what) {
  const result = sbx(spec, sbxArgs);
  if (result.status !== 0) throw sbxFailure(what, result.status, (result.stderr || result.stdout || '').trim());
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

// Linux start time of a process (field 22 of /proc/<pid>/stat), or '' where unavailable.
function processStart(pid) {
  try {
    return fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(')').pop().trim().split(/\s+/)[19] || '';
  } catch (error) {
    return '';
  }
}

function sameProcessAlive(ref) {
  if (!processAlive(ref.pid)) return false;
  const start = processStart(ref.pid);
  return !ref.start || !start || start === ref.start;
}

function readLockOwner(lockDir) {
  const parts = fs.readFileSync(path.join(lockDir, 'owner'), 'utf8').split(' ');
  return { pid: Number(parts[0]), token: parts[1] || '' };
}

// mkdir lock with an owner file ('<pid> <token>'): a lock whose owner died is taken over at
// once, and errors thrown inside fn release it on the way out. The plugin server holds this lock
// while it recreates a sandbox and runs the ensure step with its token in PASEO_SBX_LOCK_TOKEN:
// that run works inside the held lock instead of waiting for it.
function withLock(lockDir, fn) {
  const token = process.env.PASEO_SBX_LOCK_TOKEN;
  if (token) {
    try {
      if (readLockOwner(lockDir).token === token) return fn();
    } catch (error) {
      // not held: take it normally
    }
  }
  const owner = path.join(lockDir, 'owner');
  const deadline = Date.now() + 180000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(owner, process.pid + ' ');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ownerPid = 0;
      try {
        ownerPid = readLockOwner(lockDir).pid;
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

// The plugin server writes locks/<name>.recreating while it removes and recreates a sandbox.
// A marker whose owner died belongs to an interrupted recreation: drop it and carry on, since
// the ensure step creates the sandbox when it is missing.
function checkRecreating(spec) {
  const file = path.join(spec.locksDir, spec.name + '.recreating');
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return;
  }
  if (process.env.PASEO_SBX_LOCK_TOKEN && marker.token === process.env.PASEO_SBX_LOCK_TOKEN) return;
  if (sameProcessAlive(marker)) {
    throw new WrapperError('sandbox ' + spec.name + ' is being recreated; start the agent again when it finishes');
  }
  fs.rmSync(file, { force: true });
  log('removed the marker of an interrupted recreation of ' + spec.name);
}

// A running session in locks/<name>.leases/<pid>: the plugin refuses to recreate a sandbox
// while one is alive.
function writeLease(spec) {
  const dir = path.join(spec.locksDir, spec.name + '.leases');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(process.pid));
  fs.writeFileSync(file, JSON.stringify({
    pid: process.pid,
    start: processStart(process.pid),
    agentId: process.env.PASEO_AGENT_ID || null,
  }));
  process.on('exit', function () { fs.rmSync(file, { force: true }); });
}

// Same normalization as normalizeTemplateRef in shared/spec.ts.
function normalizeTemplateRef(ref) {
  const withTag = /:[^/]+$/.test(ref) ? ref : ref + ':latest';
  const parts = withTag.split('/');
  if (parts.length === 1) return 'docker.io/library/' + withTag;
  const first = parts[0];
  return first.includes('.') || first.includes(':') || first === 'localhost' ? withTag : 'docker.io/' + withTag;
}

function templateImageId(spec) {
  const wanted = normalizeTemplateRef(spec.template);
  const list = JSON.parse(sbxOk(spec, ['template', 'ls', '--json'], 'sbx template ls') || '[]');
  const match = list.find(function (entry) {
    return entry.repository + ':' + entry.tag === wanted || entry.id === spec.template;
  });
  if (!match) throw new WrapperError('template ' + spec.template + ' is not in the Paseo sbx instance (sbx template ls)');
  return match.id;
}

function ensureSandbox(spec, claude) {
  fs.mkdirSync(spec.locksDir, { recursive: true });
  fs.mkdirSync(spec.claudeConfigDir, { recursive: true });
  withLock(path.join(spec.locksDir, spec.name), function () {
    checkRecreating(spec);
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
    const imageId = spec.template ? templateImageId(spec) : null;
    const createArgs = ['create', '--name', spec.name, '--memory', spec.memory, '--no-progress'];
    if (spec.cpus > 0) createArgs.push('--cpus', String(spec.cpus));
    if (spec.template) createArgs.push('-t', spec.template, '--pull', 'never');
    sbxOk(spec, createArgs.concat(['claude'], mounts), 'sbx create ' + spec.name);
    // A recreated sandbox keeps the publications chosen for it; reconcilePublications reapplies them.
    const previous = readState(spec);
    writeState(spec, {
      publications: previous.publications || [],
      key: spec.key,
      repoKey: spec.repoKey,
      workspace: spec.workspace,
      claudeConfigDir: spec.claudeConfigDir,
      template: spec.template,
      templateImageId: imageId,
      memory: spec.memory,
      policies: [],
    });
    log('created sandbox ' + spec.name + ' (' + spec.memory + (spec.template ? ', template ' + spec.template : '') + ')');
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

const RELAY_FIRST = 41000;
const RELAY_LAST = 41999;

// Same allocation as allocateRelayPort in server/ports.ts.
function allocateRelayPort(publications, guestPort, avoid) {
  const used = new Set(publications.map(function (publication) { return publication.relayPort; }).concat(avoid));
  const span = RELAY_LAST - RELAY_FIRST + 1;
  for (let i = 0; i < span; i++) {
    const candidate = RELAY_FIRST + ((guestPort + i) % span);
    if (!used.has(candidate)) return candidate;
  }
  throw new WrapperError('no free relay port in ' + RELAY_FIRST + '-' + RELAY_LAST);
}

function freeHostPort() {
  const result = cp.spawnSync(process.execPath, ['-e',
    "const s=require('net').createServer();s.listen(0,'0.0.0.0',()=>{process.stdout.write(String(s.address().port));s.close();});",
  ], { encoding: 'utf8', env: { ELECTRON_RUN_AS_NODE: '1' } });
  const port = Number(result.stdout);
  if (!(port > 0)) throw new WrapperError('could not find a free host port');
  return port;
}

function publicationSpec(publication) {
  if (publication.allInterfaces) return '0.0.0.0:' + publication.hostPort + ':' + publication.relayPort;
  if (publication.hostPort) return '127.0.0.1:' + publication.hostPort + ':' + publication.relayPort;
  return String(publication.relayPort);
}

function sameBinding(publication, actual) {
  return (
    actual.sandbox_port === publication.relayPort &&
    actual.host_ip === (publication.allInterfaces ? '0.0.0.0' : '127.0.0.1') &&
    (!publication.hostPort || actual.host_port === publication.hostPort)
  );
}

// Every publication goes through a relay in the guest (guest-agent.py) on its own port in
// 41000-41999, forwarding to the service's port on the guest loopback: sbx publishes only what
// listens on the VM's external interface, and services that listen on 0.0.0.0 accept loopback
// connections too. Publications live in the sandbox state; this reconciles sbx with them, adding
// the repository's auto-published ports, and returns the relays the guest agent should run.
function reconcilePublications(spec, internalPorts) {
  const state = readState(spec);
  const autoPublish = spec.autoPublish || [];
  // Auto-published ports leave with the repository setting that added them.
  const publications = (state.publications || []).filter(function (publication) {
    return !publication.auto || autoPublish.includes(publication.guestPort);
  });
  for (const guestPort of autoPublish) {
    if (publications.some(function (publication) { return publication.guestPort === guestPort; })) continue;
    publications.push({
      guestPort: guestPort,
      relayPort: allocateRelayPort(publications, guestPort, internalPorts),
      hostPort: null,
      allInterfaces: false,
      reserved: false,
      auto: true,
    });
  }
  for (const publication of publications) {
    if (publication.allInterfaces && !publication.hostPort) publication.hostPort = freeHostPort();
  }
  // Listing does not start the VM; it also catches publications removed from the list.
  const actual = JSON.parse(sbxOk(spec, ['ports', spec.name, '--json'], 'sbx ports') || '[]').filter(function (entry) {
    return entry.sandbox_port >= RELAY_FIRST && entry.sandbox_port <= RELAY_LAST;
  });
  for (const entry of actual) {
    if (publications.some(function (publication) { return sameBinding(publication, entry); })) continue;
    const binding = entry.host_ip + ':' + entry.host_port + ':' + entry.sandbox_port + '/' + entry.protocol;
    sbxOk(spec, ['ports', spec.name, '--unpublish', binding], 'sbx ports --unpublish ' + binding);
  }
  for (const publication of publications) {
    if (actual.some(function (entry) { return sameBinding(publication, entry); })) continue;
    const result = sbx(spec, ['ports', spec.name, '--publish', publicationSpec(publication)]);
    if (result.status !== 0) {
      // A taken host port must not stop the session: the panel shows the publication as missing.
      log('could not publish guest port ' + publication.guestPort + ': ' + (result.stderr || result.stdout || '').trim().slice(-300));
    }
  }
  state.publications = publications;
  writeState(spec, state);
  return publications.map(function (publication) {
    return { relayPort: publication.relayPort, guestPort: publication.guestPort };
  });
}

// The guest agent's control file and port snapshot live in the sandbox's Claude config dir, the
// one mount both sides can write.
function guestStateDir(spec) {
  return path.join(spec.claudeConfigDir, '.paseo-sbx');
}

function writeRelays(spec, relays, internalPorts) {
  const dir = guestStateDir(spec);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'relays.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ relays: relays, internal: internalPorts }));
  fs.renameSync(file + '.tmp', file);
}

// One exec per launch: relays guest loopback ports to the host (Paseo's MCP server, loopback API
// URLs) and keeps the guest agent running. The VM stops 30 s after its last session and takes
// both with it, so this runs per launch.
function ensureGuestHelpers(spec, ports) {
  const script = [
    'dir=$0',
    'state=$1',
    'missing=""',
    'if [ -n "$2" ]; then missing=$(python3 "$dir/wait-ports.py" --missing $2); fi',
    'if [ -n "$missing" ]; then nohup python3 "$dir/loopback-forward.py" $missing >>/tmp/paseo-sbx-forward.log 2>&1 & fi',
    'pid=$(cat /tmp/paseo-sbx-agent.pid 2>/dev/null)',
    'if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then nohup python3 "$dir/guest-agent.py" "$state" >>/tmp/paseo-sbx-agent.log 2>&1 & fi',
    'if [ -n "$missing" ]; then python3 "$dir/wait-ports.py" --wait $missing; fi',
  ].join('\n');
  sbxOk(spec, ['exec', spec.name, 'sh', '-c', script, spec.binDir, guestStateDir(spec), ports.join(' ')], 'guest helpers');
}

// What the guest gets: Claude and Paseo variables from the session, the configured forwarded
// variables, and the sandbox's own config dir.
function guestEnv(spec) {
  const env = {};
  for (const name of Object.keys(process.env)) {
    if (HOST_ONLY.has(name) || isReserved(name)) continue;
    if (FORWARDED_NAMES.includes(name) || FORWARDED_PREFIXES.some(function (prefix) { return name.startsWith(prefix); })) {
      env[name] = process.env[name];
    }
  }
  for (const name of Object.keys(spec.env)) {
    if (isReserved(name)) log('not forwarding reserved variable ' + name);
    else env[name] = spec.env[name];
  }
  env.CLAUDE_CONFIG_DIR = spec.claudeConfigDir;
  env.PASEO_SBX_SANDBOX = spec.name;
  return env;
}

function envFilePath(spec, pid) {
  return path.join(spec.runDir, 'env-' + pid + '.list');
}

// Env files of sessions that died without cleaning up (SIGKILL).
function removeOrphanEnvFiles(spec) {
  let entries = [];
  try {
    entries = fs.readdirSync(spec.runDir);
  } catch (error) {
    return;
  }
  for (const entry of entries) {
    const match = /^env-(\d+)\.list$/.exec(entry);
    if (match && !processAlive(Number(match[1]))) fs.rmSync(path.join(spec.runDir, entry), { force: true });
  }
}

// Values reach sbx through a 0600 file outside every mount, read literally by --env-file, so they
// appear neither on a command line nor in any sbx process environment. A value with a newline
// cannot go in that file; it falls back to the client environment and -e NAME.
function writeEnvFile(spec, env) {
  fs.mkdirSync(spec.runDir, { recursive: true, mode: 0o700 });
  const file = envFilePath(spec, process.pid);
  const lines = [];
  const inline = {};
  for (const name of Object.keys(env)) {
    if (env[name].includes('\n')) {
      log('passing ' + name + ' through the sbx client environment: --env-file cannot hold newlines');
      inline[name] = env[name];
    } else {
      lines.push(name + '=' + env[name]);
    }
  }
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  process.on('exit', function () { fs.rmSync(file, { force: true }); });
  return { file: file, inline: inline };
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

// Session teardown happens in the guest. Whatever ends the session on the host (stdin closed,
// the client killed by any signal, the daemon tree-killing us), the guest's stdin reaches EOF
// and guest-supervisor.py stops Claude's process tree there. Host-side cleanup cannot do this
// reliably: the daemon tree-kills any process we spawn while it shuts us down.
function runInSandbox(spec, claude, guest) {
  const envFile = writeEnvFile(spec, guest);
  const envArgs = ['--env-file', envFile.file];
  for (const name of Object.keys(envFile.inline)) envArgs.push('-e', name);
  const execArgs = ['exec', '-i', '-w', process.cwd()].concat(envArgs, [
    spec.name, 'python3', path.join(spec.binDir, 'guest-supervisor.py'), claude,
  ], args);
  const env = Object.assign(managementEnv(spec), envFile.inline);
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
  if (spec.version !== SPEC_VERSION) throw new WrapperError('unsupported ' + SPEC_ENV + ' version ' + spec.version);
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
  removeOrphanEnvFiles(spec);
  checkRecreating(spec);
  if (args[0] !== ENSURE_FLAG) writeLease(spec);
  ensureSandbox(spec, claude);
  const guest = guestEnv(spec);
  const ports = detectPorts(spec, guest);
  ensurePolicy(spec, ports);
  const relays = withLock(path.join(spec.locksDir, spec.name), function () { return reconcilePublications(spec, ports); });
  writeRelays(spec, relays, ports);
  if (args[0] === ENSURE_FLAG) {
    // Publications need their relays now; without any, preparing a sandbox does not enter it.
    if (relays.length > 0) ensureGuestHelpers(spec, []);
    return;
  }
  ensureGuestHelpers(spec, ports);
  log('sandbox=' + spec.name + ' cwd=' + process.cwd() + ' claude=' + claude);
  runInSandbox(spec, claude, guest);
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

/**
 * Long-running guest process, one per VM. Every 2 s it reconciles the publication relays listed
 * in `<state>/relays.json` (relay port on all guest interfaces → the service's port on the guest
 * loopback) and writes the guest's listening TCP ports to `<state>/listeners.json`, so the host
 * can show them without an `sbx exec` (which would postpone the auto-stop).
 */
export const GUEST_AGENT_SOURCE = String.raw`# Written by the paseo-sbx Paseo plugin.
import asyncio, json, os, sys, time

STATE = sys.argv[1]
RELAYS = os.path.join(STATE, "relays.json")
LISTENERS = os.path.join(STATE, "listeners.json")


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


def handler(guest_port):
    async def handle(client_reader, client_writer):
        for host in ("127.0.0.1", "::1"):
            try:
                reader, writer = await asyncio.open_connection(host, guest_port)
                break
            except OSError:
                continue
        else:
            client_writer.close()
            return
        await asyncio.gather(pipe(client_reader, writer), pipe(reader, client_writer))
    return handle


def read_control():
    try:
        with open(RELAYS) as file:
            data = json.load(file)
        relays = {int(entry["relayPort"]): int(entry["guestPort"]) for entry in data.get("relays", [])}
        return relays, {int(port) for port in data.get("internal", [])}
    except (OSError, ValueError, KeyError, TypeError):
        return None, set()


def address(hex_address):
    if len(hex_address) == 8:
        return ".".join(str(int(hex_address[i:i + 2], 16)) for i in (6, 4, 2, 0))
    if hex_address == "0" * 32:
        return "::"
    if hex_address == "0" * 24 + "01000000":
        return "::1"
    return "ipv6"


def listening():
    found = {}
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table) as file:
                rows = file.read().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            fields = row.split()
            if len(fields) < 4 or fields[3] != "0A":
                continue
            hex_address, hex_port = fields[1].split(":")
            port = int(hex_port, 16)
            found.setdefault(port, set()).add(address(hex_address))
    return found


def write_listeners(skip):
    ports = [
        {"port": port, "addresses": sorted(addresses)}
        for port, addresses in sorted(listening().items())
        if port not in skip
    ][:500]
    temporary = LISTENERS + ".tmp"
    with open(temporary, "w") as file:
        json.dump({"at": time.time(), "listeners": ports}, file)
    os.replace(temporary, LISTENERS)


async def main():
    with open(os.environ.get("PASEO_SBX_AGENT_PID", "/tmp/paseo-sbx-agent.pid"), "w") as file:
        file.write(str(os.getpid()))
    os.makedirs(STATE, exist_ok=True)
    servers = {}
    while True:
        relays, internal = read_control()
        if relays is not None:
            for relay_port in list(servers):
                guest_port, server = servers[relay_port]
                if relays.get(relay_port) != guest_port:
                    server.close()
                    del servers[relay_port]
            for relay_port, guest_port in relays.items():
                if relay_port in servers:
                    continue
                try:
                    server = await asyncio.start_server(handler(guest_port), ["0.0.0.0", "::"], relay_port)
                except OSError:
                    try:
                        server = await asyncio.start_server(handler(guest_port), "0.0.0.0", relay_port)
                    except OSError as error:
                        print(f"relay {relay_port} -> {guest_port}: {error}", file=sys.stderr, flush=True)
                        continue
                servers[relay_port] = (guest_port, server)
        try:
            write_listeners(set(servers) | internal)
        except OSError as error:
            print(f"listeners: {error}", file=sys.stderr, flush=True)
        await asyncio.sleep(2)


asyncio.run(main())
`;
