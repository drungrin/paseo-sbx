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
- **Templates**: a default template for new sandboxes, and one per repository in the workspace's **Sandbox** panel. **Prepare template** opens a shell in a clean sandbox to install your tools, then saves it.
- **Memory**: a percentage of host RAM per sandbox (10% by default) with a minimum, plus a per-repository value in the workspace's **Sandbox** panel.
- **Extra mounts**: toolchains and shared tool state your agents need, such as a version manager's install directory (`:ro` for read-only).
- **Forwarded variables**: values your agents get from your shell profile on the host, read from a dotenv file (`~/.config/paseo-sbx/env` by default). Only Claude and Paseo variables reach the sandbox automatically; tokens such as `GH_TOKEN` must be listed here.
- **Allowed destinations** and **Extra host ports**: the sandbox network policy and additional host loopback ports to relay.
- **Excluded paths**: workspaces that keep running Claude on the host when routing is on.

The **Sandboxes** screen shows the memory the VMs hold, the host's available RAM, swap and memory pressure, with an alert past configurable thresholds, and lists the agents keeping each VM running, with an **Archive** action. The workspace **Sandbox** panel shows the sandbox, the agents keeping it running, its template, mounts and variables, and opens a terminal inside it for manual checks. Settings for a repository apply to every worktree of it.

## Limits

- Terminals, workspace scripts and services from `paseo.json` still run on the host.
- Template, mounts, memory and CPUs are fixed when a sandbox is created. **Recreate** applies new ones once every agent of the sandbox is archived; it discards what runs inside the VM. Existing agents keep the sandbox they started in when you change the isolation mode.
- Templates do not include the images of the VM's own Docker: each new sandbox pulls them again.
- **Stop** in the panel shuts the VM's Docker down first. The automatic stop 30 seconds after the last agent, and a restart of Paseo, are abrupt for what runs inside: databases go through crash recovery on the next start.
- Memory figures come from an internal detail of Docker Sandboxes 0.49 and show as unknown if a later version changes it. Linux only.
- Each open workspace keeps a VM running, about 1 GB of memory at idle plus its workload, and each VM has its own image cache on disk.
- Hooks or plugins in your Claude settings that call host-only binaries fail inside the sandbox.
- This is process isolation, not a security boundary: the default network policy allows everything and forwarded variables are visible to agents.
