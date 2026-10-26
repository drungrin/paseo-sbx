import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// A fake sbx that keeps sandboxes and templates in a JSON file, logs every call with the names in
// its environment, and runs `exec` commands locally with a VM-like environment: PATH plus the
// `--env-file` values and the `-e NAME` variables only. Like sbx 0.49, `template save` refuses a
// running sandbox, and `exec` or `ports --publish` start a stopped one.
export const FAKE_SBX = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_SBX_STATE;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
state.sandboxes = state.sandboxes || [];
state.templates = state.templates || [];
state.stopped = state.stopped || [];
const start = (name) => { state.stopped = state.stopped.filter((entry) => entry !== name); };
fs.appendFileSync(process.env.FAKE_SBX_LOG, JSON.stringify({ args, stateHome: process.env.XDG_STATE_HOME, envNames: Object.keys(process.env) }) + '\\n');
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
if (args[0] === 'ls') {
  if (process.env.FAKE_SBX_LS_ERROR) { process.stderr.write(process.env.FAKE_SBX_LS_ERROR); process.exit(1); }
  process.stdout.write(JSON.stringify(state.sandboxes.map((name) => ({ name, status: state.stopped.includes(name) ? 'stopped' : 'running' }))));
} else if (args[0] === 'create') {
  if (process.env.FAKE_SBX_FAIL_CREATE) { process.stderr.write('create refused'); process.exit(3); }
  state.sandboxes.push(args[args.indexOf('--name') + 1]);
  save();
} else if (args[0] === 'rm') {
  state.sandboxes = state.sandboxes.filter((name) => name !== args[args.length - 1]);
  save();
} else if (args[0] === 'stop') {
  if (!state.stopped.includes(args[1])) state.stopped.push(args[1]);
  save();
} else if (args[0] === 'policy') {
  // accepted
} else if (args[0] === 'ports') {
  state.ports = state.ports || {};
  const name = args[1];
  const bindings = state.ports[name] || [];
  const taken = (process.env.FAKE_SBX_TAKEN_PORTS || '').split(',').filter(Boolean).map(Number);
  if (args[2] === '--json') {
    process.stdout.write(JSON.stringify(bindings));
  } else if (args[2] === '--publish') {
    start(name);
    const parts = args[3].split(':');
    const sandboxPort = Number(parts.pop());
    const hostPort = parts.length > 0 ? Number(parts.pop()) : 32768 + bindings.length;
    const hostIp = parts.length > 0 ? parts.pop() : '127.0.0.1';
    if (taken.includes(hostPort)) { process.stderr.write('error: port not available'); process.exit(1); }
    bindings.push({ host_ip: hostIp, host_port: hostPort, sandbox_port: sandboxPort, protocol: 'tcp4' });
    state.ports[name] = bindings;
    save();
  } else if (args[2] === '--unpublish') {
    state.ports[name] = bindings.filter((entry) => entry.host_ip + ':' + entry.host_port + ':' + entry.sandbox_port + '/' + entry.protocol !== args[3]);
    save();
  }
} else if (args[0] === 'template' && args[1] === 'ls') {
  process.stdout.write(JSON.stringify(state.templates));
} else if (args[0] === 'template' && args[1] === 'save') {
  const [name, tag] = [args[2], args[3]];
  if (!state.stopped.includes(name)) {
    process.stderr.write(process.stdin.isTTY ? 'Sandbox ' + name + ' is running and must be stopped before saving. Stop it now? (y/N)' : 'error: stdin is not a terminal; pass --force to skip the confirmation');
    process.exit(1);
  }
  if (!state.sandboxes.includes(name)) { process.stderr.write('no such sandbox'); process.exit(1); }
  const [repo, version] = tag.includes(':') ? tag.split(':') : [tag, 'latest'];
  state.templates.push({ id: Math.random().toString(16).slice(2, 14), repository: 'docker.io/library/' + repo, tag: version });
  save();
  // Like sbx, on stderr.
  process.stderr.write('\\x1b[1A  Saved template docker.io/library/' + repo + ':' + version + '\\r\\n');
} else if (args[0] === 'template' && args[1] === 'rm') {
  const ref = args[args.length - 1];
  state.templates = state.templates.filter((entry) => entry.repository + ':' + entry.tag !== ref);
  save();
} else if (args[0] === 'exec') {
  let i = 1;
  let cwd = process.cwd();
  const env = { PATH: process.env.PATH };
  for (; i < args.length; i++) {
    if (args[i] === '-i' || args[i] === '-it') continue;
    // Commands for the guest's root (the plugin's dockerd shutdown) must never run on the
    // test host: report FAKE_SBX_ROOT_EXIT instead.
    if (args[i] === '-u') process.exit(Number(process.env.FAKE_SBX_ROOT_EXIT || 0));
    if (args[i] === '-w') { cwd = args[++i]; continue; }
    if (args[i] === '-e') { const name = args[++i]; env[name] = process.env[name] === undefined ? '' : process.env[name]; continue; }
    if (args[i] === '--env-file') {
      for (const line of fs.readFileSync(args[++i], 'utf8').split('\\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      continue;
    }
    break;
  }
  if (!state.sandboxes.includes(args[i])) { process.stderr.write('no such sandbox'); process.exit(1); }
  start(args[i]);
  save();
  // The plugin's guest helpers (relays, the guest agent) are long-running guest processes: do not
  // start them on the test host.
  if (args[i + 1] === 'sh' && String(args[i + 3] || '').includes('guest-agent.py')) process.exit(0);
  const guest = cp.spawn(args[i + 1], args.slice(i + 2), { cwd, env, stdio: ['pipe', 'inherit', 'inherit'], detached: true });
  if (process.env.FAKE_SBX_DETACH) {
    // Like a client that exits on stdin EOF while the guest keeps running.
    guest.stdin.end();
    guest.unref();
    process.exit(0);
  }
  // The guest's stdin is a pipe from the client: it reaches EOF when the client goes away.
  process.stdin.pipe(guest.stdin);
  guest.stdin.on('error', () => {});
  guest.on('exit', (code) => process.exit(code === null ? 1 : code));
} else {
  process.exit(2);
}
`;

export interface SbxCall {
  args: string[];
  stateHome: string;
  envNames: string[];
}

export interface FakeSbx {
  bin: string;
  /** Environment that points sbx at the fake. */
  env: Record<string, string>;
  calls(): SbxCall[];
  clearCalls(): void;
  setState(state: { sandboxes?: string[]; templates?: { id: string; repository: string; tag: string }[] }): void;
  sandboxes(): string[];
}

/** Installs the fake sbx in `<root>/fakebin`. */
export function installFakeSbx(root: string): FakeSbx {
  const bin = join(root, "fakebin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "sbx"), FAKE_SBX);
  chmodSync(join(bin, "sbx"), 0o755);
  const stateFile = join(root, "sbx-state.json");
  const log = join(root, "sbx.log");
  return {
    bin,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_SBX_STATE: stateFile,
      FAKE_SBX_LOG: log,
    },
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as SbxCall)
        : [],
    clearCalls: () => rmSync(log, { force: true }),
    setState: (state) => writeFileSync(stateFile, JSON.stringify(state)),
    sandboxes: () => (existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")).sandboxes ?? []) : []),
  };
}
