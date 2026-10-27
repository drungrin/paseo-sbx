Sandboxes runs each workspace's Claude and Codex agents inside its own Docker Sandboxes microVM. Agents keep working on the same files at the same paths, but every Docker container, network, port and test browser they start lives in that workspace's VM. Sessions stop interfering with each other: a Postgres on port 5432 in one workspace does not collide with another, and container churn in one workspace no longer breaks Chromium tests in another.

## How it works

The plugin adds `claude-sbx` and `codex-sbx` providers that extend Paseo's own Claude and Codex integrations. Paseo itself stays on the host; the agent's CLI, from the sandbox's template, and the tools it runs move into the VM. The workspace is mounted at its host path, so the file explorer, diffs and git keep working unchanged. Agents sign in through sbx's secrets, which its proxy adds to their requests: the token never enters the VM.

Sandboxes come from a Docker Sandboxes instance that belongs to Paseo: your own `sbx` sandboxes are not listed or touched, and Paseo's sandboxes stop when the daemon stops. A sandbox is created the first time a sandboxed agent starts in a workspace and stops on its own 30 seconds after its last agent closes. Each agent also has a small catalog sandbox that answers Paseo's version and model questions, so no agent CLI is needed on the host.

Each sandbox gets its own Claude config directory. Your settings, `CLAUDE.md`, skills, agents and rules are linked in read-only from your Claude config directory, while transcripts and state stay per sandbox. Paseo's MCP server and any loopback API endpoint your Claude settings use are relayed into the VM automatically.

## Setup

Requires a Linux host with the Docker Sandboxes CLI (`sbx`) installed and signed in, and Paseo 0.13 or later. The `sbx` login lives in the OS keyring, which must be unlocked; on a headless host use a keyring without a password.

Turn on the agents you want under **Agents** in the plugin settings, then open **Sandboxes** in the sidebar and press **Configure** for each; the first time downloads sbx's kit for it. Store the agent's login once with `XDG_STATE_HOME=~/.local/state/paseo-sbx/sbx sbx secret set <service>` (`openai`, with `--oauth` for a ChatGPT login; `anthropic` if your Claude does not already sign in through its own settings) and press **Update**. Then pick **Claude (sandbox)** or **Codex (sandbox)** when creating an agent, or turn on **Run new Claude agents in sandboxes**.

## Settings

- **Agents**: which sandboxed agents the plugin registers (Claude by default). Turning one off disables its provider and keeps its agents.
- **One sandbox per**: workspace (default) or directory. Workspaces that share a directory get separate VMs in workspace mode.
- **Templates**: a default template for new sandboxes, and one per repository in the workspace's **Sandbox** panel. **Prepare template** opens a shell in a clean sandbox to install your tools, then saves it.
- **Resources**: memory as a percentage of host RAM per sandbox (10% by default) with a minimum, CPUs (all by default) and the size of the VM's Docker disk (sbx's 10 GB by default). A repository picks its own memory and CPUs in the workspace's **Sandbox** panel. Builds start a process per CPU, so a repository with little memory may need fewer CPUs.
- **Extra mounts**: shared tool state and credentials your agents need, for every repository or for one in its **Sandbox** panel (`:ro` for read-only). A mount under your home also appears at the same place under the agent's home. Install tools in a template instead.
- **GSD Path**: a repository with a `.gsd-path` directory gets `~/.gsd-path` and the member checkouts listed in `.project/MEMBERS.md`, writable. The **Sandbox** panel lists the members.
- **Forwarded variables**: names of the variables your agents get from your shell profile, for every repository or for one in its **Sandbox** panel. The daemon does not load your shell profile, so values come from a dotenv file (`~/.config/paseo-sbx/env` by default; your shell's env file works too, `export NAME=value` lines included), then the daemon environment. Only Claude and Paseo variables reach the sandbox automatically.
- **GitHub over HTTPS** (on by default): GitHub SSH remotes go over HTTPS inside the sandbox, where the sbx proxy signs in with your token. Store it once with `XDG_STATE_HOME=~/.local/state/paseo-sbx/sbx sbx secret set github --command "$(command -v gh) auth token"`; the token never enters the sandbox.
- **Allowed destinations** and **Extra host ports**: the sandbox network policy and additional host loopback ports to relay.
- **Excluded paths**: workspaces that keep running Claude on the host when routing is on.

## Services

The workspace **Sandbox** panel lists the ports listening inside the VM. **Publish** makes one reachable from the host, on `127.0.0.1` by default or on every host address, with a port picked for you or fixed. That is how you check an app an agent started in the sandbox, without building it on the host. A port can be published for every sandbox of the repository, and services listening only on the VM's loopback work too.

The **Sandboxes** screen shows the memory the VMs hold, the host's available RAM, swap and memory pressure, with an alert past configurable thresholds, and lists the agents keeping each VM running, with an **Archive** action. The workspace **Sandbox** panel shows the sandbox, the agents keeping it running, its template, mounts and variables, and opens a terminal inside it for manual checks. Settings for a repository apply to every worktree of it.

## Limits

- Terminals, workspace scripts and services from `paseo.json` still run on the host.
- A template carries the CLIs of the agents it was prepared with: a workspace running Claude and Codex needs a template with both. Codex in a sandbox created before agents shared their homes asks for a Recreate. Importing Codex sessions from the host's `~/.codex` is not supported.
- Template, mounts, memory, CPUs and Docker disk are fixed when a sandbox is created. **Recreate** applies new ones once every agent of the sandbox is archived; it discards what runs inside the VM. Existing agents keep the sandbox they started in when you change the isolation mode.
- Templates do not include the images of the VM's own Docker: each new sandbox pulls them again.
- **Stop** in the panel shuts the VM's Docker down first. The automatic stop 30 seconds after the last agent, and a restart of Paseo, are abrupt for what runs inside: databases go through crash recovery on the next start.
- Memory figures come from an internal detail of Docker Sandboxes 0.49 and show as unknown if a later version changes it. Linux only.
- Each open workspace keeps a VM running, about 1 GB of memory at idle plus its workload, and each VM has its own image cache on disk.
- Hooks or plugins in your Claude settings that call host-only binaries fail inside the sandbox.
- This is process isolation, not a security boundary: the default network policy allows everything and forwarded variables are visible to agents.
