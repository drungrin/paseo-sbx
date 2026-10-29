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
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

// Set by the launcher so an Electron-hosted daemon runs us as Node; nothing below needs it.
delete process.env.ELECTRON_RUN_AS_NODE;

const SPEC_ENV = 'PASEO_SBX_SPEC';
const SPEC_VERSION = 3;
const ENSURE_FLAG = '--paseo-sbx-ensure';
const SHELL_FLAG = '--paseo-sbx-shell';
// The agent this launcher serves; the launcher sets it, Paseo's arguments arrive untouched.
const AGENT = process.env.PASEO_SBX_AGENT || 'claude';
delete process.env.PASEO_SBX_AGENT;
const FORWARDED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'PASEO_', 'MCP_', 'DISABLE_'];
const FORWARDED_NAMES = ['API_TIMEOUT_MS', 'MAX_THINKING_TOKENS', 'LANG', 'TZ', 'NO_BROWSER'];
// Credentials in the daemon's environment stay out of every sbx process: the sandbox daemon
// would inherit them when a call starts it.
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ACCESS_KEY|PRIVATE_KEY)/i;
// A catalog run Paseo started outside a session (no spec) is cut off after this long.
const CATALOG_TIMEOUT_MS = 600000;
// Host paths or plugin plumbing that mean nothing inside the VM.
const HOST_ONLY = new Set([SPEC_ENV, 'PASEO_HOME', 'CLAUDE_ENV_FILE', 'CLAUDE_CONFIG_DIR']);
// The sbx client reads these itself; a forwarded value would redirect the host-side client.
const RESERVED = new Set(['PATH', 'HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS']);
const RESERVED_PREFIXES = ['SBX_', 'DOCKER_'];
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
    if (!isSessionValue(name, spec) && !CREDENTIAL_NAME.test(name)) env[name] = process.env[name];
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
// extraEnv carries settings the sbx client reads itself, never session values.
function sbx(spec, sbxArgs, extraEnv) {
  const result = cp.spawnSync('sbx', sbxArgs, {
    env: Object.assign(managementEnv(spec), extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 600000,
  });
  if (result.error) throw new WrapperError('sbx ' + sbxArgs[0] + ': ' + result.error.message);
  return result;
}

function sbxOk(spec, sbxArgs, what, extraEnv) {
  const result = sbx(spec, sbxArgs, extraEnv);
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
  let held = false;
  if (token) {
    try {
      held = readLockOwner(lockDir).token === token;
    } catch (error) {
      // not held: take it normally
    }
  }
  if (held) return fn();
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

// sbx's built-in agents; a template's flavor starts with the one whose kit built it.
const SBX_AGENTS = ['claude', 'codex', 'copilot', 'cursor', 'devin', 'docker-agent', 'droid', 'gemini', 'kiro', 'opencode', 'shell'];

function templateInfo(spec) {
  const wanted = normalizeTemplateRef(spec.template);
  const list = JSON.parse(sbxOk(spec, ['template', 'ls', '--json'], 'sbx template ls') || '[]');
  const match = list.find(function (entry) {
    return entry.repository + ':' + entry.tag === wanted || entry.id === spec.template;
  });
  if (!match) throw new WrapperError('template ' + spec.template + ' is not in the Paseo sbx instance (sbx template ls)');
  const flavor = String(match.flavor || '');
  const kit = SBX_AGENTS.filter(function (agent) { return flavor.startsWith(agent); })
    .sort(function (a, b) { return b.length - a.length; })[0];
  return { id: match.id, kit: kit || spec.kit };
}

function ensureSandbox(spec) {
  fs.mkdirSync(spec.locksDir, { recursive: true });
  fs.mkdirSync(spec.claudeConfigDir, { recursive: true });
  // Mounted even before an agent uses it, so adding an agent later needs no Recreate.
  fs.mkdirSync(spec.agentHome ? spec.agentHome.path : spec.homesDir, { recursive: true });
  withLock(path.join(spec.locksDir, spec.name), function () {
    checkRecreating(spec);
    const list = JSON.parse(sbxOk(spec, ['ls', '--json'], 'sbx ls') || '[]');
    if (list.some(function (sandbox) { return sandbox.name === spec.name; })) return;
    // Without a template sbx creates from its kit image, which it downloads from Docker Hub
    // when it is not cached: only with your consent. A template's image is local.
    if (!spec.template && !spec.allowImageDownloads) {
      throw new WrapperError(
        'creating ' + spec.name + " without a template can download sbx's " + spec.kit + ' kit image from Docker Hub:' +
          ' allow image downloads in Docker Sandboxes → Agents, or in the plugin settings, first',
      );
    }
    const seen = new Set([spec.workspace]);
    const mounts = [spec.workspace];
    // The configured mounts it gets; the workspace panel compares them with the current settings.
    const created = [];
    // The agents' CLIs come from the template: nothing of the host's is mounted for them.
    const extra = spec.mounts.concat([spec.binDir + ':ro', spec.claudeConfigDir]);
    for (const entry of extra) {
      const target = mountPath(entry);
      if (seen.has(target)) continue;
      if (!fs.existsSync(target)) {
        log('skipping missing mount ' + target);
        continue;
      }
      seen.add(target);
      mounts.push(entry);
      if (spec.mounts.includes(entry)) created.push(entry);
    }
    // sbx applies an agent's kit to the template's image: the one that built the template, or,
    // without a template, the kit of the agent starting the sandbox.
    const template = spec.template ? templateInfo(spec) : null;
    const imageId = template ? template.id : null;
    const createArgs = ['create', '--name', spec.name, '--memory', spec.memory, '--no-progress'];
    if (spec.cpus > 0) createArgs.push('--cpus', String(spec.cpus));
    if (spec.template) createArgs.push('-t', spec.template, '--pull', 'never');
    // sbx's per-sandbox override of its global sandbox.disk.dockerVolume setting.
    const createEnv = spec.dockerDisk ? { DOCKER_SANDBOXES_DOCKER_SIZE: spec.dockerDisk } : undefined;
    sbxOk(spec, createArgs.concat([template ? template.kit : spec.kit], mounts), 'sbx create ' + spec.name, createEnv);
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
      cpus: spec.cpus,
      dockerDisk: spec.dockerDisk,
      mounts: created,
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
// the session environment (including forwarded variables and your Claude settings' env), and
// anything the sandbox's own Claude settings point at.
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

// Reconciles the sandbox's network rules with the spec, revoking rules it no longer lists. Host
// loopback port rules are only added: agents sharing the VM each report their own ports, and
// revoking one session's would cut off another's.
function ensurePolicy(spec, ports) {
  withLock(path.join(spec.locksDir, spec.name), function () {
    const state = readState(spec);
    const applied = new Set(state.policies || []);
    const wanted = new Set(spec.networkAllow.concat(ports.map(function (port) { return 'localhost:' + port; })));
    for (const rule of applied) if (rule.startsWith('localhost:')) wanted.add(rule);
    const missing = Array.from(wanted).filter(function (rule) { return !applied.has(rule); });
    const stale = Array.from(applied).filter(function (rule) { return !wanted.has(rule); });
    if (missing.length > 0) {
      sbxOk(spec, ['policy', 'allow', 'network', '--sandbox', spec.name, missing.join(',')], 'sbx policy allow');
    }
    for (const rule of stale) {
      // Without --force, sbx asks for confirmation and fails without a terminal.
      sbxOk(spec, ['policy', 'rm', 'network', '--sandbox', spec.name, '--resource', rule, '--force'], 'sbx policy rm ' + rule);
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

function freeHostPort(host) {
  const result = cp.spawnSync(process.execPath, ['-e',
    "const s=require('net').createServer();s.listen(0,process.argv[1],()=>{process.stdout.write(String(s.address().port));s.close();});",
    host,
  ], { encoding: 'utf8', env: { ELECTRON_RUN_AS_NODE: '1' } });
  const port = Number(result.stdout);
  if (!(port > 0)) throw new WrapperError('could not find a free host port');
  return port;
}

function hostIp(publication) {
  return publication.allInterfaces ? '0.0.0.0' : '127.0.0.1';
}

function publicationSpec(publication) {
  return hostIp(publication) + ':' + publication.hostPort + ':' + publication.relayPort;
}

function sameBinding(publication, actual) {
  return (
    actual.sandbox_port === publication.relayPort &&
    actual.host_ip === hostIp(publication) &&
    actual.host_port === publication.hostPort
  );
}

// Every publication goes through a relay in the guest (guest-agent.py) on its own port in
// 41000-41999, forwarding to the service's port on the guest loopback: sbx publishes only what
// listens on the VM's external interface, and services that listen on 0.0.0.0 accept loopback
// connections too. Publications live in the sandbox state; this reconciles sbx with them, adding
// the repository's auto-published ports, and returns the relays the guest agent should run.
//
// Every publication gets an explicit host port. sbx 0.49 restores its publications at every
// start, and keeps an ephemeral one as port 0, which --unpublish cannot match: it would come back
// at each restart and duplicate the one published here. An explicit port is removed for good,
// restored as is, and keeps the URL stable.
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
    if (!publication.hostPort) publication.hostPort = freeHostPort(hostIp(publication));
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
    // sbx may have restored it between the listing and now.
    if (result.status !== 0 && !/already published/.test(result.stderr || '')) {
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
  let internal = internalPorts;
  // As with the policy: keep the loopback ports other sessions reported.
  try {
    internal = Array.from(new Set(internal.concat(JSON.parse(fs.readFileSync(file, 'utf8')).internal || [])));
  } catch (error) {
    // no earlier report
  }
  fs.writeFileSync(file + '.tmp', JSON.stringify({ relays: relays, internal: internal }));
  fs.renameSync(file + '.tmp', file);
}

// Arguments for home-mounts.sh: NAME TARGET pairs.
function homeMountArgs(spec) {
  const pairs = [];
  for (const mount of spec.homeMounts || []) pairs.push(mount.name, mount.target);
  return pairs;
}

// One exec per launch: starts the sandbox's own Claude settings from the kit's, mounts into the
// guest's home, relays guest loopback ports to the host (Paseo's MCP server, loopback API URLs)
// and keeps the guest agent running. The VM stops
// 30 s after its last session and takes the relays and the agent with it, so this runs per launch.
function ensureGuestHelpers(spec, ports) {
  const script = [
    'dir=$0',
    'state=$1',
    'ports=$2',
    'config=$3',
    'shift 3',
    'python3 "$dir/seed-claude-settings.py" "$config"',
    'sh "$dir/home-mounts.sh" "$@"',
    'missing=""',
    'if [ -n "$ports" ]; then missing=$(python3 "$dir/wait-ports.py" --missing $ports); fi',
    'if [ -n "$missing" ]; then nohup python3 "$dir/loopback-forward.py" $missing >>/tmp/paseo-sbx-forward.log 2>&1 & fi',
    'pid=$(cat /tmp/paseo-sbx-agent.pid 2>/dev/null)',
    'if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then nohup python3 "$dir/guest-agent.py" "$state" >>/tmp/paseo-sbx-agent.log 2>&1 & fi',
    'if [ -n "$missing" ]; then python3 "$dir/wait-ports.py" --wait $missing; fi',
  ].join('\n');
  const output = sbxOk(
    spec,
    ['exec', spec.name, 'sh', '-c', script, spec.binDir, guestStateDir(spec), ports.join(' '), spec.claudeConfigDir].concat(
      homeMountArgs(spec),
    ),
    'guest helpers',
  );
  for (const line of output.split('\n')) if (line.trim()) log(line.trim());
}

// The MCP servers sbx's record of the sandbox's gateway lists (sbx 0.49), read as readLoadedMcp
// in server/mcp.ts reads it: null when the record does not fit.
function loadedMcp(spec) {
  const dir = path.join(spec.stateHome, 'sandboxes', 'sandboxes', 'sandboxd', 'mcp', 'gateways');
  if (!fs.existsSync(dir)) return null;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, spec.name + '.json'), 'utf8'));
  } catch (error) {
    return error.code === 'ENOENT' ? [] : null;
  }
  if (!record || typeof record.runtime_id !== 'string') return null;
  const set = record.dynamic_added_set;
  if (set === undefined) return [];
  return Array.isArray(set) && set.every(function (name) { return typeof name === 'string'; }) ? set : null;
}

// Brings the sandbox's MCP gateway to the repository's choices, with the plan of planMcp in
// shared/mcp.ts. Loading works on a stopped VM; unloading needs it running, so a stopped one keeps
// its unloads waiting. Failures are recorded for the workspace panel and never stop a launch.
function reconcileMcp(spec, running) {
  try {
    const wanted = spec.mcpServers || [];
    const loaded = loadedMcp(spec);
    const state = readState(spec);
    const before = state.mcpAutoLoad || [];
    const off = new Set((state.mcpUnload || []).concat(before).filter(function (name) { return !wanted.includes(name); }));
    const toLoad = wanted.filter(function (name) { return !loaded || !loaded.includes(name); });
    const toUnload = Array.from(off).filter(function (name) { return !loaded || loaded.includes(name); });
    if (toLoad.length === 0 && toUnload.length === 0 && before.join() === wanted.join()) return;
    const errors = {};
    for (const name of toLoad) {
      const result = sbx(spec, ['mcp', 'load', name, '--sandbox', spec.name]);
      if (result.status === 0) continue;
      errors[name] = (result.stderr || result.stdout || '').trim() || 'exit ' + result.status;
      log('loading MCP server ' + name + ' failed: ' + errors[name]);
    }
    const waiting = [];
    for (const name of toUnload) {
      if (!running) {
        waiting.push(name);
        continue;
      }
      const result = sbx(spec, ['mcp', 'unload', name, '--sandbox', spec.name]);
      const output = (result.stderr || result.stdout || '').trim();
      if (result.status === 0 || /is not loaded|is not registered/.test(output)) continue;
      waiting.push(name);
      errors[name] = output || 'exit ' + result.status;
      log('unloading MCP server ' + name + ' failed: ' + errors[name]);
    }
    withLock(path.join(spec.locksDir, spec.name), function () {
      const current = readState(spec);
      current.mcpAutoLoad = wanted;
      current.mcpUnload = waiting;
      current.mcpErrors = errors;
      writeState(spec, current);
    });
  } catch (error) {
    log('MCP servers not applied: ' + (error && error.message ? error.message : String(error)));
  }
}

// What the guest gets: Claude and Paseo variables from the session, the configured forwarded
// variables, and the sandbox's own config dir.
// Your Claude settings stay on the host, out of every VM; their env (a gateway's URL and token,
// a key) reaches each run through its private env file, read fresh at every launch.
function hostSettingsEnv(file) {
  const env = {};
  if (!file) return env;
  let settingsEnv;
  try {
    settingsEnv = JSON.parse(fs.readFileSync(file, 'utf8')).env || {};
  } catch (error) {
    if (error.code !== 'ENOENT') log('could not read ' + file + ': ' + error.message);
    return env;
  }
  for (const name of Object.keys(settingsEnv)) {
    if (typeof settingsEnv[name] === 'string' && !isReserved(name)) env[name] = settingsEnv[name];
  }
  return env;
}

function guestEnv(spec) {
  const env = {};
  for (const name of Object.keys(process.env)) {
    if (HOST_ONLY.has(name) || isReserved(name)) continue;
    if (FORWARDED_NAMES.includes(name) || FORWARDED_PREFIXES.some(function (prefix) { return name.startsWith(prefix); })) {
      env[name] = process.env[name];
    }
  }
  if (spec.agent === 'claude') Object.assign(env, hostSettingsEnv(spec.hostClaudeSettings));
  for (const name of Object.keys(spec.env)) {
    if (isReserved(name)) log('not forwarding reserved variable ' + name);
    else env[name] = spec.env[name];
  }
  env.CLAUDE_CONFIG_DIR = spec.claudeConfigDir;
  if (spec.agentHome) env[spec.agentHome.env] = spec.agentHome.path;
  env.PASEO_SBX_SANDBOX = spec.name;
  // guest-supervisor.py adds sbx's MCP gateway to Claude's MCP config; Codex's kit configures it.
  if (spec.agent === 'claude') env.PASEO_SBX_MCP_GATEWAY = '1';
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

const IMAGE_LIMIT = 20 * 1024 * 1024;

// Codex gets prompt images as files in a host temp dir that no sandbox mounts. Each is copied
// into the sandbox's config dir, mounted at the same path on both sides, and the message points
// there.
function copyImage(spec, source) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.size > IMAGE_LIMIT) throw new Error(source + ' is not a regular file under 20 MB');
  const data = fs.readFileSync(source);
  const dir = path.join(guestStateDir(spec), 'images');
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.createHash('sha256').update(data).digest('hex').slice(0, 24) + path.extname(source);
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) fs.writeFileSync(target, data, { mode: 0o600 });
  return target;
}

function rewriteImages(spec, value) {
  if (Array.isArray(value)) {
    for (const item of value) rewriteImages(spec, item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'localImage' && typeof value.path === 'string') {
    value.path = copyImage(spec, value.path);
    return;
  }
  for (const key of Object.keys(value)) rewriteImages(spec, value[key]);
}

// The app-server protocol is one JSON message per line. Only lines naming a local image are
// parsed; everything else, and any line that fails, passes through as it came.
function imageRewriter(spec) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  function rewriteLine(line) {
    if (!line.includes('"localImage"')) return line;
    try {
      const message = JSON.parse(line);
      rewriteImages(spec, message);
      return JSON.stringify(message);
    } catch (error) {
      log('passing a prompt image through unchanged: ' + error.message);
      return line;
    }
  }
  return new Transform({
    transform: function (chunk, encoding, done) {
      pending += decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop();
      done(null, lines.map(function (line) { return rewriteLine(line) + '\n'; }).join(''));
    },
    flush: function (done) {
      pending += decoder.end();
      done(null, pending ? rewriteLine(pending) : '');
    },
  });
}

// Session teardown happens in the guest. Whatever ends the session on the host (stdin closed,
// the client killed by any signal, the daemon tree-killing us), the guest's stdin reaches EOF
// and guest-supervisor.py stops the agent's process tree there. Host-side cleanup cannot do this
// reliably: the daemon tree-kills any process we spawn while it shuts us down.
function runInSandbox(spec, guest) {
  const envFile = writeEnvFile(spec, guest);
  const envArgs = ['--env-file', envFile.file];
  for (const name of Object.keys(envFile.inline)) envArgs.push('-e', name);
  const execArgs = ['exec', '-i', '-w', spec.agentCwd].concat(envArgs, [
    spec.name, 'python3', path.join(spec.binDir, 'guest-supervisor.py'), spec.binary,
  ], args);
  const env = Object.assign(managementEnv(spec), envFile.inline);
  const rewrite = spec.agent === 'codex';
  const child = cp.spawn('sbx', execArgs, { stdio: [rewrite ? 'pipe' : 'inherit', 'inherit', 'inherit'], env: env });
  if (rewrite) {
    child.stdin.on('error', function () {});
    process.stdin.pipe(imageRewriter(spec)).pipe(child.stdin);
  }
  relaySignals(function () { child.kill('SIGTERM'); });
  child.on('exit', exitLikeChild);
}

// Paseo's catalog, diagnostic, archive and history runs carry no session spec. They go to the
// agent's catalog sandbox, which the plugin creates from sbx's kit when the agent is configured
// and describes in catalog/<agent>.json, next to the bin dir.
function readCatalog() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', AGENT + '.json'), 'utf8'));
  } catch (error) {
    return null;
  }
}

// The catalog's sbx calls need only the instance and the run dir; no session values exist.
function catalogTarget(catalog) {
  return { stateHome: catalog.stateHome, runDir: catalog.runDir, env: {} };
}

// Paseo adds PASEO_AGENT_ID to every session's environment. A daemon started from inside an agent
// session (a nested or development daemon) carries one of its own, which every spawn inherits:
// the same value in the parent's (the daemon's) environment means no session.
function sessionAgentId() {
  const id = process.env.PASEO_AGENT_ID;
  if (!id) return null;
  try {
    const parent = fs.readFileSync('/proc/' + process.ppid + '/environ', 'utf8').split('\0');
    if (parent.includes('PASEO_AGENT_ID=' + id)) return null;
  } catch (error) {
    // no /proc: count it as a session
  }
  return id;
}

function isVersionQuery() {
  return args.length === 1 && (args[0] === '--version' || args[0] === '-v');
}

// Paseo asks for the version before probing models, within seconds, and then probes the catalog
// right away. The version comes from the catalog's record; the VM starts meanwhile.
function answerVersion(catalog) {
  process.stdout.write(catalog.cliVersion + '\n');
  const warm = cp.spawn('sbx', ['exec', catalog.name, 'true'], {
    detached: true,
    stdio: 'ignore',
    env: managementEnv(catalogTarget(catalog)),
  });
  warm.unref();
}

function catalogEnv(catalog) {
  const env = {};
  for (const name of Object.keys(process.env)) {
    if (HOST_ONLY.has(name) || isReserved(name)) continue;
    if (FORWARDED_NAMES.includes(name) || FORWARDED_PREFIXES.some(function (prefix) { return name.startsWith(prefix); })) {
      env[name] = process.env[name];
    }
  }
  Object.assign(env, hostSettingsEnv(catalog.hostSettings));
  if (catalog.claudeConfigDir) env.CLAUDE_CONFIG_DIR = catalog.claudeConfigDir;
  if (catalog.agentHome) env[catalog.agentHome.env] = catalog.agentHome.path;
  return env;
}

function runInCatalog(catalog) {
  const target = catalogTarget(catalog);
  const env = catalogEnv(catalog);
  const detected = new Set();
  for (const name of Object.keys(env)) {
    if (name.startsWith('ANTHROPIC_')) collectLoopbackPorts(env[name] || '', detected);
  }
  // Only ports the catalog's policy allows are relayed; Update the catalog after adding one.
  const ports = Array.from(detected).filter(function (port) { return catalog.ports.includes(port); });
  if (ports.length < detected.size) log('the ' + AGENT + ' catalog does not relay every loopback port its settings use: update it');
  const helpers = ports.length > 0
    ? 'missing=$(python3 "$1" --missing ' + ports.join(' ') + '); ' +
      'if [ -n "$missing" ]; then nohup python3 "$2" $missing >>/tmp/paseo-sbx-forward.log 2>&1 & python3 "$1" --wait $missing; fi; '
    : '';
  const envFile = writeEnvFile(target, env);
  const envArgs = ['--env-file', envFile.file];
  for (const name of Object.keys(envFile.inline)) envArgs.push('-e', name);
  const execArgs = ['exec', '-i', '-w', catalog.workdir].concat(envArgs, [
    catalog.name, 'sh', '-c', helpers + 'shift 2; exec python3 "$0" "$@"',
    path.join(catalog.binDir, 'guest-supervisor.py'),
    path.join(catalog.binDir, 'wait-ports.py'),
    path.join(catalog.binDir, 'loopback-forward.py'),
    catalog.binary,
  ], args);
  const child = cp.spawn('sbx', execArgs, { stdio: 'inherit', env: Object.assign(managementEnv(target), envFile.inline) });
  // A CLI waiting for an interactive login would otherwise hold the run forever.
  const timer = setTimeout(function () {
    log('the ' + AGENT + ' catalog run took over ' + CATALOG_TIMEOUT_MS / 1000 + ' s; stopping it');
    child.kill('SIGTERM');
  }, CATALOG_TIMEOUT_MS);
  timer.unref();
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

// The Sandbox terminal profile's shell: a login shell in the workspace's sandbox, in the
// workspace, created when missing. The spec is the one the plugin last built for the workspace
// (PASEO_WORKSPACE_ID, set in every Paseo terminal), recorded without its variables. The tab
// shows the title its process sets, else this command line, and the VM's shell sets none.
function shellMain() {
  process.stdout.write('\x1b]0;Sandbox\x07');
  const workspaceId = process.env.PASEO_WORKSPACE_ID || '';
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
    throw new WrapperError('the Sandbox terminal runs in a workspace terminal: PASEO_WORKSPACE_ID is missing');
  }
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workspaces', workspaceId + '.json'), 'utf8'));
  } catch (error) {
    throw new WrapperError(
      "this workspace's sandbox is not known yet: open its Sandbox dashboard once, or run Open sandbox terminal from the command center",
    );
  }
  if (spec.version !== SPEC_VERSION) throw new WrapperError('the workspace record is from another plugin version: open its Sandbox dashboard once');
  removeOrphanEnvFiles(spec);
  checkRecreating(spec);
  ensureSandbox(spec);
  const guest = shellEnv(spec);
  const ports = detectPorts(spec, guest);
  ensurePolicy(spec, ports);
  const relays = withLock(path.join(spec.locksDir, spec.name), function () { return reconcilePublications(spec, ports); });
  writeRelays(spec, relays, ports);
  ensureGuestHelpers(spec, ports);
  reconcileMcp(spec, true);
  const envFile = writeEnvFile(spec, guest);
  const envArgs = ['--env-file', envFile.file];
  for (const name of Object.keys(envFile.inline)) envArgs.push('-e', name);
  const rcfile = path.join(spec.binDir, 'paseo-sbx-shellrc');
  const child = cp.spawn('sbx', ['exec', '-it', '-w', spec.workspace].concat(envArgs, [spec.name, 'bash', '--rcfile', rcfile, '-i']), {
    stdio: 'inherit',
    env: Object.assign(managementEnv(spec), envFile.inline),
  });
  relaySignals(function (signal) { child.kill(signal); });
  child.on('exit', exitLikeChild);
}

// What a session gets, for whichever agent you start by hand: Claude's config dir and your
// Claude settings' env (your login), and Codex's shared home. The workspace record holds no
// forwarded values, so variables from the variables file are not here.
function shellEnv(spec) {
  const env = guestEnv(Object.assign({}, spec, { agent: 'claude', agentHome: null }));
  delete env.PASEO_SBX_MCP_GATEWAY;
  env.CODEX_HOME = path.join(spec.homesDir, 'codex');
  return env;
}

function main() {
  if (args[0] === SHELL_FLAG) return shellMain();
  const spec = readSpec();
  if (!spec) {
    // A session always gets a spec from the plugin. One without (plugin disabled or failed)
    // must not run anywhere; the plugin marks the history runs it sends to the catalog.
    const agentId = sessionAgentId();
    if (agentId && process.env.PASEO_SBX_ROUTE !== 'catalog') {
      throw new WrapperError(
        'missing ' + SPEC_ENV + ': ' + AGENT + '-sbx sessions need the paseo-sbx plugin enabled (agent ' + agentId + ')',
      );
    }
    const catalog = readCatalog();
    if (!catalog) {
      throw new WrapperError('no catalog sandbox for ' + AGENT + ': press Configure for it in Docker Sandboxes, Agents tab');
    }
    if (isVersionQuery()) return answerVersion(catalog);
    return runInCatalog(catalog);
  }
  removeOrphanEnvFiles(spec);
  checkRecreating(spec);
  if (args[0] !== ENSURE_FLAG) writeLease(spec);
  ensureSandbox(spec);
  if (spec.agentHome) {
    const created = readState(spec).mounts;
    if (created && !created.includes(spec.homesDir)) {
      throw new WrapperError(spec.name + ' predates shared agent homes: recreate it from its workspace panel to run ' + spec.agent);
    }
  }
  const guest = guestEnv(spec);
  const ports = detectPorts(spec, guest);
  ensurePolicy(spec, ports);
  const relays = withLock(path.join(spec.locksDir, spec.name), function () { return reconcilePublications(spec, ports); });
  writeRelays(spec, relays, ports);
  if (args[0] === ENSURE_FLAG) {
    // Publications need their relays now; without any, preparing a sandbox does not enter it.
    // Home mounts then wait for the first session, or for the Sandbox terminal.
    if (relays.length > 0) ensureGuestHelpers(spec, []);
    reconcileMcp(spec, relays.length > 0);
    return;
  }
  ensureGuestHelpers(spec, ports);
  reconcileMcp(spec, true);
  log('sandbox=' + spec.name + ' agent=' + spec.agent + ' cwd=' + spec.agentCwd);
  runInSandbox(spec, guest);
}

try {
  main();
} catch (error) {
  fail(error instanceof WrapperError ? error.message : (error && error.stack) || String(error));
}
`;

/**
 * Shell launcher registered as an agent's provider command: names the agent for the wrapper,
 * which receives Paseo's arguments untouched, and restores Node mode for Electron hosts.
 */
export function launcherSource(nodeBinary: string, wrapperPath: string, agent: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# Written by the paseo-sbx Paseo plugin. Do not edit: the plugin rewrites it on startup.",
    "# The daemon may run inside Electron, whose binary acts as Node only with this variable.",
    `PASEO_SBX_AGENT=${agent} ELECTRON_RUN_AS_NODE=1 exec ${quote(nodeBinary)} ${quote(wrapperPath)} "$@"`,
    "",
  ].join("\n");
}

/** Command of the Sandbox terminal profile: the wrapper's shell mode, with the daemon's node. */
export function shellLauncherSource(nodeBinary: string, wrapperPath: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# Written by the paseo-sbx Paseo plugin. Do not edit: the plugin rewrites it on startup.",
    `ELECTRON_RUN_AS_NODE=1 exec ${quote(nodeBinary)} ${quote(wrapperPath)} --paseo-sbx-shell`,
    "",
  ].join("\n");
}

// The Sandbox terminal's bash: a login shell's startup, then claude with sbx's MCP gateway,
// as sessions get it from guest-supervisor.py. Commands that open no session are left alone.
export const SHELL_RC_SOURCE = String.raw`# Written by the paseo-sbx Paseo plugin.
[ -f /etc/profile ] && . /etc/profile
for profile in ~/.bash_profile ~/.bash_login ~/.profile; do
  if [ -f "$profile" ]; then . "$profile"; break; fi
done
claude() {
  case "$1" in
    agents|attach|auth|auto-mode|config|doctor|gateway|import|install|logs|mcp|migrate-installer|plugin|plugins|purge|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade)
      command claude "$@"
      return
      ;;
  esac
  if [ -z "$MCP_GATEWAY_URL" ]; then
    command claude "$@"
    return
  fi
  token=$MCP_SENTINEL_TOKEN_NAME
  [ -n "$token" ] || token=proxy-managed
  command claude --mcp-config "{\"mcpServers\":{\"mcp-gateway\":{\"type\":\"http\",\"url\":\"$MCP_GATEWAY_URL\",\"headers\":{\"Authorization\":\"Bearer $token\"}}}}" "$@"
}
`;

// Each sandbox keeps its own Claude settings: they start as the kit's (sbx writes them in the
// guest home at creation), and from then on Claude in the sandbox owns them, plugins and all.
// The kit's apiKeyHelper is left out: sessions get the sbx secret's marker from the plugin.
export const SEED_SETTINGS_SOURCE = String.raw`# Written by the paseo-sbx Paseo plugin.
import json
import os
import sys

config = sys.argv[1] if len(sys.argv) > 1 else ""
target = os.path.join(config, "settings.json")
kit = os.path.expanduser("~/.claude/settings.json")
if config and os.path.isdir(config) and not os.path.lexists(target):
    try:
        with open(kit) as source:
            settings = json.load(source)
    except (OSError, ValueError):
        settings = {}
    if not isinstance(settings, dict):
        settings = {}
    settings.pop("apiKeyHelper", None)
    temp = target + ".%d.tmp" % os.getpid()
    with open(temp, "w") as out:
        json.dump(settings, out, indent=2)
        out.write("\n")
    os.replace(temp, target)
`;

/**
 * Bind-mounts host-home mounts into the guest's home: arguments are NAME TARGET pairs, NAME relative
 * to $HOME. Runs as the sandbox user at every launch (binds do not survive a VM restart), with sudo
 * for the mount itself. Not a symlink: GSD Path refuses symlinked runtime storage. Whatever the
 * template or sbx already put at NAME wins.
 */
export const HOME_MOUNTS_SOURCE = String.raw`# Written by the paseo-sbx Paseo plugin.
while [ $# -ge 2 ]; do
  path="$HOME/$1"
  target=$2
  shift 2
  # A mount sbx skipped (missing on the host) gets nothing.
  [ -e "$target" ] || continue
  # Earlier plugin versions linked it instead.
  if [ -L "$path" ] && [ "$(readlink "$path")" = "$target" ]; then rm -f "$path"; fi
  # Bound already since the VM started. mountpoint follows links, hence the -L.
  [ -L "$path" ] || ! mountpoint -q "$path" 2>/dev/null || continue
  if [ -d "$target" ]; then
    if [ -L "$path" ] || { [ -e "$path" ] && { [ ! -d "$path" ] || [ -n "$(ls -A "$path")" ]; }; }; then
      echo "$path already exists in the sandbox; not mounting $target there"
      continue
    fi
    mkdir -p "$path"
  else
    if [ -L "$path" ] || { [ -e "$path" ] && { [ ! -f "$path" ] || [ -s "$path" ]; }; }; then
      echo "$path already exists in the sandbox; not mounting $target there"
      continue
    fi
    mkdir -p "$(dirname "$path")" && : >>"$path"
  fi
  sudo -n mount --bind "$target" "$path" || echo "could not mount $target at $path: it needs passwordless sudo in the sandbox"
done
`;

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
import json, os, signal, subprocess, sys, threading, time

GRACE = float(os.environ.get("PASEO_SBX_STOP_GRACE", "5"))


def with_gateway(argv):
    # sbx's own launch registers its MCP gateway in a config dir Claude does not use here: merge
    # the same entry into Paseo's --mcp-config, or pass one of its own.
    url = os.environ.get("MCP_GATEWAY_URL")
    if os.environ.pop("PASEO_SBX_MCP_GATEWAY", None) != "1" or not url:
        return argv
    token = os.environ.get("MCP_SENTINEL_TOKEN_NAME") or "proxy-managed"
    gateway = {"type": "http", "url": url, "headers": {"Authorization": "Bearer " + token}}
    for index in range(len(argv) - 1):
        if argv[index] != "--mcp-config":
            continue
        try:
            config = json.loads(argv[index + 1])
        except ValueError:
            continue
        servers = config.get("mcpServers") if isinstance(config, dict) else None
        if isinstance(servers, dict):
            servers.setdefault("mcp-gateway", gateway)
            return argv[: index + 1] + [json.dumps(config)] + argv[index + 2 :]
    return argv + ["--mcp-config", json.dumps({"mcpServers": {"mcp-gateway": gateway}})]


try:
    child = subprocess.Popen(with_gateway(sys.argv[1:]), stdin=subprocess.PIPE, start_new_session=True)
except FileNotFoundError:
    sys.stderr.write("[paseo-sbx] %s is not in this sandbox: its template lacks it. Add it to the template, or pick one built for it\n" % sys.argv[1])
    sys.exit(127)
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
