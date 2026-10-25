# paseo-sbx

A Paseo plugin that runs each workspace's Claude agents inside its own [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) microVM. See [OVERVIEW.md](OVERVIEW.md) for what it does and its settings.

## Requirements

- Linux host. Developed on Ubuntu 26.04 with `sbx` 0.49.
- `sbx` installed and signed in (`sbx login`). The login token lives in the OS keyring: on a headless host, use a keyring without a password, or `sbx` stops answering (HTTP 503) once the keyring locks.
- Claude Code installed on the host and on `PATH`. The sandbox runs the host binary through a read-only mount, so host and sandbox image need compatible glibc versions.
- `python3` in the sandbox image (the default `claude` image has it).
- Paseo 0.12.0 or later.

## Install

```bash
paseo plugin install /path/to/paseo-sbx
```

Then open **Sandboxes** in the sidebar and press **Configure** to register the `claude-sbx` provider.

## How it works

| Piece | Where | Role |
| --- | --- | --- |
| Plugin server | Paseo daemon | Settings, the `agent.session_open` hook that builds each session's sandbox spec, the optional `agent.create` hook that routes `claude` to `claude-sbx`, RPCs for the UI |
| Wrapper (`paseo-sbx-claude.cjs`) | Host, spawned by Paseo as the provider command | Creates the sandbox and its policy, starts the loopback relay, runs the host's Claude Code inside the VM |
| `guest-supervisor.py` | Sandbox | Feeds Claude's stdin and stops its process tree when the session ends |
| `loopback-forward.py` | Sandbox | Relays guest `127.0.0.1:<port>` to the host's loopback |

The server bundle cannot read files from the plugin directory, so the plugin writes the wrapper and the guest helpers to `~/.local/state/paseo-sbx/bin` on startup and registers the provider with `config.patch`.

State lives under `~/.local/state/paseo-sbx` (respects `XDG_STATE_HOME`):

- `sbx/`: the Paseo-only `sbx` instance (`XDG_STATE_HOME` for `sbx`). Inspect it with `XDG_STATE_HOME=~/.local/state/paseo-sbx/sbx sbx ls`.
- `claude/<sandbox>/`: per-sandbox Claude config directories. Paseo reads transcripts here for history and rewind.
- `sandboxes/<sandbox>.json`: network rules already applied to each sandbox.

### Design decisions

- **Fail closed.** The wrapper refuses to start a session without the spec the plugin injects. With the plugin disabled, `claude-sbx` agents fail with a clear error instead of running on the host. Only Paseo's model catalogue probe and `--version` run on the host.
- **Teardown inside the guest.** The `sbx exec` client can exit while Claude is still inside a tool call, and the daemon tree-kills the wrapper and anything it spawns during shutdown. The guest supervisor stops Claude's process tree once its stdin reaches EOF, which happens however the session ends on the host.
- **Paseo-only `sbx`.** Paseo's sandboxes live in their own `sbx` instance, started by the daemon on demand. Restarting Paseo stops them; your own sandboxes are unaffected.
- **Secrets stay off command lines.** Forwarded values travel in the `sbx` client's environment; only variable names appear in `sbx exec` arguments.

## Working inside a sandbox

- `PASEO_SBX_SANDBOX` is set to the sandbox name, so scripts can detect they run in a sandbox.
- k3d needs two flags inside the VM, which has no `/dev/kmsg`:
  `--volume "/dev/null:/dev/kmsg@server:*" --k3s-arg "--kube-proxy-arg=conntrack-max-per-core=0@server:*"`.
- Build outputs record absolute cache paths. When the same checkout is built on the host and in a sandbox (or in two sandboxes), restore before testing: for .NET, `dotnet test --no-build` can otherwise pass while running no tests.
- A .NET SDK mounted read-only needs `DOTNET_SKIP_WORKLOAD_INTEGRITY_CHECK=1` in a fresh sandbox.

## Troubleshooting

- **`claude-sbx` agents fail with "missing PASEO_SBX_SPEC"**: the plugin is disabled or failed to load (`paseo plugin ls`).
- **The Sandboxes screen shows the daemon as unavailable**: run `XDG_STATE_HOME=~/.local/state/paseo-sbx/sbx sbx daemon status`. A locked keyring is the usual cause.
- **Agents cannot reach a host service**: add its port under **Extra host ports**. Inside the sandbox, `127.0.0.1:<port>` is relayed to the host.
- **Wrapper logs** appear in the daemon log as Claude Agent SDK stderr lines prefixed with `[paseo-sbx]`.

## Development

```bash
npm install
npm run typecheck
npm test
```

The wrapper tests run the real wrapper against a fake `sbx` that keeps sandboxes in a JSON file and runs `exec` commands locally, with a VM-like environment and its own stdin pipe.
