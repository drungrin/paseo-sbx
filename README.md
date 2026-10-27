# paseo-sbx

A Paseo plugin that runs each workspace's Claude and Codex agents inside its own [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) microVM. See [OVERVIEW.md](OVERVIEW.md) for what it does and its settings.

## Requirements

- Linux host. Developed on Ubuntu 26.04 with `sbx` 0.49.
- `sbx` installed and signed in (`sbx login`). The login token lives in the OS keyring: on a headless host, use a keyring without a password, or `sbx` stops answering (HTTP 503) once the keyring locks.
- `python3` in the sandbox image (sbx's agent images have it). The agents' CLIs come from the sandbox's template, so none needs to be installed on the host.
- Paseo 0.13.0 or later.

## Install

```bash
paseo plugin install /path/to/paseo-sbx
```

Then open **Sandboxes** in the sidebar and, in its **Agents** tab, press **Configure** for each agent: it registers the agent's provider (`claude-sbx`, `codex-sbx`) and creates its catalog sandbox.

## How it works

| Piece | Where | Role |
| --- | --- | --- |
| Plugin server | Paseo daemon | Settings, the `agent.session_open` hook that builds each session's sandbox spec, the optional `agent.create` hook that routes `claude` to `claude-sbx`, RPCs for the UI |
| Launchers (`paseo-sbx-claude`, `paseo-sbx-codex`) | Host, the registered provider commands | Run the wrapper with the daemon's own Node (in Node mode when the daemon runs inside Electron), naming the agent |
| Wrapper (`paseo-sbx-claude.cjs`) | Host | Creates the sandbox, reconciles its network policy, starts the loopback relay, runs the agent's CLI from the template inside the VM; sends runs without a session to the agent's catalog sandbox |
| `guest-supervisor.py` | Sandbox | Feeds Claude's stdin and stops its process tree when the session ends |
| `loopback-forward.py` | Sandbox | Relays guest `127.0.0.1:<port>` to the host's loopback |
| `guest-agent.py` | Sandbox | Runs the relays of published ports and reports the guest's listening ports |

The server bundle cannot read files from the plugin directory, so the plugin writes the launcher, the wrapper and the guest helpers to `~/.local/state/paseo-sbx/bin` on startup and registers the provider with `config.patch`, keeping any label, env or model fields you customized on that entry.

State lives under `~/.local/state/paseo-sbx` (respects `XDG_STATE_HOME`):

- `sbx/`: the Paseo-only `sbx` instance (`XDG_STATE_HOME` for `sbx`). Inspect it with `XDG_STATE_HOME=~/.local/state/paseo-sbx/sbx sbx ls`.
- `claude/<sandbox>/`: per-sandbox Claude config directories. Paseo reads transcripts here for history and rewind.
- `catalog/<agent>.json` and `catalog/<agent>/`: each agent's catalog sandbox (name, the kit's CLI version, what its runs need) and its workspace.
- `homes/<agent>/`: agents' homes shared by every sandbox and the catalog, at the same path inside them (Codex's `CODEX_HOME`).
- `sandboxes/<sandbox>.json`: how each sandbox was created (repository, template and its image ID, memory, CPUs, Docker disk, mounts) and the network rules applied to it. Removing a rule from the settings revokes it on the next launch.
- `locks/`: per-sandbox locks, the leases of running sessions, and the marker of a recreation in progress.
- `run/`: per-session env files, private to your user and never mounted.
- `agents/<agent>.json`: the sandbox each agent first opened in. Resume, refresh and history reuse it, so changing the isolation mode does not move existing agents or their transcripts.

### Design decisions

- **Fail closed, and nothing on the host.** The wrapper refuses to start a session without the spec the plugin injects: with the plugin disabled, sandboxed agents fail with a clear error. Paseo runs some things outside sessions (model catalog, diagnostics, Codex's archive and unarchive, history of archived agents); those go to the agent's catalog sandbox, never to the host. A session is told apart by the `PASEO_AGENT_ID` Paseo adds to it, unless the daemon itself was started with that value (a daemon launched from an agent session).
- **One launcher per agent.** Some of Paseo's version probes run only the provider command with `--version`, dropping any argument, so the agent cannot be an argument: each agent's launcher names it in the environment.
- **CLIs from the template.** Sessions run the CLI found on the template's `PATH`; a template built for one agent's kit lacks the others, so a workspace with both Claude and Codex agents needs a template with both. sbx applies a kit to a template's image only if the kit built it: sandboxes are created with the kit the template's flavor names, or the starting agent's without a template.
- **The catalog answers without a session.** Each agent's catalog sandbox is created from sbx's kit, without your workspace, and records the CLI's version. Paseo asks for the version first and gives Claude's model probe 5 s, so the version comes from the record while the catalog VM starts. Claude's settings reach the catalog without their `env` (a gateway's token): the env goes to each run through its private env file.
- **Login through sbx's secrets.** The sbx proxy swaps a `proxy-managed` marker for the stored secret, in any sandbox and for a secret stored after the sandbox was created. A kit writes its markers when created: the catalog's are copied into the agent's shared home (Codex's `auth.json`), so API keys and OAuth work without the plugin knowing their format. Update after storing a secret. Claude keeps signing in on its own (a gateway, a key, Bedrock, Vertex, an `apiKeyHelper`); the `anthropic` secret applies only when nothing else does.
- **Codex's home is shared.** Codex's threads must be reachable from the catalog, which runs its archive, unarchive and history; one `CODEX_HOME` for every sandbox works like `~/.codex` on a host with several sessions. Sandboxes created before it have no mount for it: Codex there asks for a Recreate. Prompt images Codex gets as host temp files are copied into the sandbox's config dir on their way in.
- **Credentials stay out of sbx processes.** Names that look like credentials in the daemon's environment are dropped from every `sbx` call, so the sandbox daemon never inherits them. Claude's shared items are mounted one by one, never the config dir with its credentials.
- **Teardown inside the guest.** The `sbx exec` client can exit while Claude is still inside a tool call, and the daemon tree-kills the wrapper and anything it spawns during shutdown. The guest supervisor stops Claude's process tree once its stdin reaches EOF, which happens however the session ends on the host.
- **Paseo-only `sbx`.** Paseo's sandboxes live in their own `sbx` instance, started by the daemon on demand. Restarting Paseo stops them; your own sandboxes are unaffected.
- **Secrets stay out of sbx processes.** Forwarded values reach the guest through a 0600 file in `run/`, passed with `sbx exec --env-file` and deleted when the session ends (files of sessions that were killed go at the next launch). No sbx client runs with them in its environment, so the sandbox daemon never inherits them, whichever call starts it. A value with a newline cannot go in that file and falls back to the client environment. Variables the `sbx` client reads itself (`PATH`, `HOME`, `XDG_*`, `SBX_*`, `DOCKER_*`, ...) are never forwarded.
- **Settings per repository.** Templates, memory, CPUs, mounts and variables are keyed by the repository's git common dir, so every worktree of a repo shares them while each gets its own sandbox. A sandbox keeps the repository it was created for. Version 1 per-sandbox overrides that could not move to one repository are listed in the Sandboxes screen to reassign.
- **Templates.** A template is a saved sandbox filesystem in the Paseo instance (`sbx template save`). It does not include the images of the VM's own Docker. sbx saves only a stopped sandbox, so the plugin stops it first and refuses while sessions run in it. Prepare one in a clean sandbox, without your variables or credentials: saving a working sandbox captures `/home/agent`, login tokens included.
- **Recreate needs archived agents.** The plugin API can neither close nor reopen an agent's runtime, and a resident agent can start a turn at any time, so the plugin recreates a sandbox only when every agent bound to it is archived and no session runs. The server holds the sandbox lock for the whole operation and marks it so new launches fail fast.
- **Home mounts are bind mounts.** A mount under your home is bind-mounted at the same place under the guest's home at every launch, with the sandbox user's sudo, since binds do not survive a VM restart. A symlink would need no root, but GSD Path refuses symlinked runtime storage.
- **Docker disk per sandbox.** sbx sizes `/var/lib/docker` from `sandbox.disk.dockerVolume`, a setting shared by every sbx instance of your user. The plugin passes `DOCKER_SANDBOXES_DOCKER_SIZE` to `sbx create` instead, so your own sandboxes keep sbx's size. The volume is sparse on the host.
- **Memory without entering the VM.** Each VM's resident memory is read from its `containerd-shim-nerdbox-v1` process, matched to the sandbox through the `config.json` in the process's working directory. Any `sbx exec` would postpone the auto-stop, and polling through it would keep VMs running.
- **Every publication goes through a relay.** sbx publishes only what listens on the VM's external interface, and dev servers often listen on loopback. The guest agent listens on a port of its own (41000-41999) and forwards to the service's port on the guest loopback, which also reaches services listening on `0.0.0.0`. Its own port keeps it from blocking the service if the service later binds every address. The agent writes the listening ports to the sandbox's Claude config dir, the one mount both sides can write, so the panel lists them without `sbx exec`; the host reads that file as untrusted input. Publications are kept per sandbox and reconciled at every launch; a repository's auto-published ports are added there. Each gets an explicit host port, picked when you leave it empty: sbx 0.49 restores publications at every start and keeps an ephemeral one in a form `--unpublish` cannot remove, so it would come back after each restart. An explicit port is removed for good and keeps the URL stable.
- **No stop on archive.** Archiving an agent closes its runtime, and the VM stops 30 seconds after its last session. What keeps VMs running is agents that are not archived; the plugin API cannot close their runtimes, so the Sandboxes screen lists them with an Archive action.
- **Invalid settings fail instead of defaulting.** Falling back to defaults could silently turn routing off or reopen the network policy. The plugin keeps the last valid settings it read; without any, `claude-sbx` sessions and routed agent creation fail with a message pointing to the settings screen.

### What reaches the guest environment

Automatically: variables starting with `ANTHROPIC_`, `CLAUDE_`, `PASEO_`, `MCP_` or `DISABLE_`, plus `API_TIMEOUT_MS`, `MAX_THINKING_TOKENS`, `LANG`, `TZ` and `NO_BROWSER`, from the daemon environment. Paseo's MCP server is relayed from the daemon's port in its config, since Codex gets the MCP URL inside its protocol. Anything else your tools need (license keys, cloud credentials) goes under **Forwarded variables**, with values in the variables file. The plugin adds `GIT_CONFIG_*` entries for **GitHub over HTTPS** after any you forward, and, in a repository using GSD Path, `GSD_PATH_WORKTREE_ROOT` at the host's `~/.gsd-path/projects`: GSD Path would otherwise register worktrees created in the guest under the guest's home, a path the host's git cannot reach. Importing a host Claude session into `claude-sbx` copies that project's transcripts into the sandbox's config directory first.

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
- **A build dies with exit code 137**: the VM ran out of memory. Give the repository more memory or fewer CPUs in the **Resources** tab of its **Sandbox** panel, then recreate the sandbox.
- **Tests fail with "No space left on device"** from a database in the VM's Docker: raise **Docker disk per sandbox**, then recreate the sandbox.
- **A published port shows "not published"**: its host port was taken when the sandbox started. Pick another fixed port, or leave it empty.
- **Wrapper logs** appear in the daemon log as Claude Agent SDK stderr lines prefixed with `[paseo-sbx]`.

## Development

```bash
npm install
npm run typecheck
npm test
```

The wrapper tests run the real wrapper against a fake `sbx` that keeps sandboxes in a JSON file and runs `exec` commands locally, with a VM-like environment and its own stdin pipe.
