Sandboxes runs each workspace's Claude agents inside its own Docker Sandboxes microVM. Agents keep working on the same files at the same paths, but every Docker container, network, port and test browser they start lives in that workspace's VM. Sessions stop interfering with each other: a Postgres on port 5432 in one workspace does not collide with another, and container churn in one workspace no longer breaks Chromium tests in another.

## How it works

The plugin adds a `claude-sbx` provider that extends the built-in Claude integration. Paseo itself stays on the host; only the Claude Code process and the tools it runs move into the VM. The workspace is mounted at its host path, so the file explorer, diffs and git keep working unchanged.

Sandboxes come from a Docker Sandboxes instance that belongs to Paseo: your own `sbx` sandboxes are not listed or touched, and Paseo's sandboxes stop when the daemon stops. A sandbox is created the first time a `claude-sbx` agent starts in a workspace and stops on its own 30 seconds after its last agent closes.

Each sandbox gets its own Claude config directory. Your settings, `CLAUDE.md`, skills, agents and rules are linked in read-only from your Claude config directory, while transcripts and state stay per sandbox. Paseo's MCP server and any loopback API endpoint your Claude settings use are relayed into the VM automatically.

## Setup

Requires a Linux host with the Docker Sandboxes CLI (`sbx`) installed and signed in, Claude Code installed on the host, and Paseo 0.12 or later. The `sbx` login lives in the OS keyring, which must be unlocked; on a headless host use a keyring without a password.

Open **Sandboxes** in the sidebar and press **Configure** to register the provider. Then pick **Claude (sandbox)** when creating an agent, or turn on **Run new Claude agents in sandboxes** in the plugin settings.

## Settings

- **One sandbox per**: workspace (default) or directory. Workspaces that share a directory get separate VMs in workspace mode.
- **Memory**: a percentage of host RAM per sandbox (10% by default) with a minimum, plus a per-workspace override in the workspace's **Sandbox** panel.
- **Extra mounts**: toolchains and shared tool state your agents need, such as a version manager's install directory (`:ro` for read-only).
- **Forwarded variables**: values your agents get from your shell profile on the host, read from a dotenv file (`~/.config/paseo-sbx/env` by default).
- **Allowed destinations** and **Extra host ports**: the sandbox network policy and additional host loopback ports to relay.
- **Excluded paths**: workspaces that keep running Claude on the host when routing is on.

The workspace **Sandbox** panel shows the sandbox, its mounts and variables, and opens a terminal inside it for manual checks.

## Limits

- Terminals, workspace scripts and services from `paseo.json` still run on the host.
- Mounts, memory and CPUs are fixed when a sandbox is created; remove it from the panel to recreate it.
- Stopping a sandbox is abrupt for what runs inside it: databases go through crash recovery on the next start.
- Each open workspace keeps a VM running, about 1 GB of memory at idle plus its workload, and each VM has its own image cache on disk.
- Hooks or plugins in your Claude settings that call host-only binaries fail inside the sandbox.
- This is process isolation, not a security boundary: the default network policy allows everything and forwarded variables are visible to agents.
