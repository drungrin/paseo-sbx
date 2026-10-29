import { DOWNLOAD_TERMS } from "./consent";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { AGENTS, AGENT_IDS, type AgentId } from "../shared/agents";
import { sandboxSettings, type IsolationMode, type SandboxSettings } from "../shared/settings";
import { invalidEnvNames, invalidMounts, parseList, parsePortList } from "../shared/spec";
import { useTemplates } from "./queries";

interface Draft {
  enabledAgents: AgentId[];
  allowImageDownloads: boolean;
  routeClaudeAgents: boolean;
  gsdPath: boolean;
  isolation: IsolationMode;
  memoryPercent: string;
  memoryFloorGiB: string;
  cpus: string;
  dockerDiskGiB: string;
  githubHttps: boolean;
  psiPercent: string;
  availablePercent: string;
  template: string;
  mounts: string;
  claudeShared: string;
  envFile: string;
  envNames: string;
  networkAllow: string;
  forwardPorts: string;
  excludedPaths: string;
}

function toDraft(values: SandboxSettings): Draft {
  return {
    enabledAgents: values.enabledAgents,
    allowImageDownloads: values.allowImageDownloads,
    routeClaudeAgents: values.routeClaudeAgents,
    gsdPath: values.gsdPath,
    isolation: values.isolation,
    memoryPercent: String(values.memoryPercent),
    memoryFloorGiB: String(values.memoryFloorGiB),
    cpus: String(values.cpus),
    dockerDiskGiB: String(values.dockerDiskGiB),
    githubHttps: values.githubHttps,
    psiPercent: String(values.memoryAlert.psiPercent),
    availablePercent: String(values.memoryAlert.availablePercent),
    template: values.template,
    // The host's input is single-line: lists are comma-separated.
    mounts: values.mounts.join(", "),
    claudeShared: values.claudeShared.join(", "),
    envFile: values.envFile,
    envNames: values.envNames.join(", "),
    networkAllow: values.networkAllow.join(", "),
    forwardPorts: values.forwardPorts.join(", "),
    excludedPaths: values.excludedPaths.join(", "),
  };
}

function fromDraft(draft: Draft, base: SandboxSettings): SandboxSettings | string {
  const memoryPercent = Number(draft.memoryPercent);
  const memoryFloorGiB = Number(draft.memoryFloorGiB);
  const cpus = Number(draft.cpus);
  if (!(memoryPercent >= 1 && memoryPercent <= 90)) return "Memory percent must be between 1 and 90.";
  if (!(memoryFloorGiB >= 1)) return "Memory floor must be at least 1 GiB.";
  if (!(Number.isInteger(cpus) && cpus >= 0)) return "CPUs must be a whole number (0 = all).";
  const dockerDiskGiB = Number(draft.dockerDiskGiB);
  if (!(Number.isInteger(dockerDiskGiB) && dockerDiskGiB >= 0)) return "Docker disk must be a whole number of GiB (0 = sbx's).";
  const psiPercent = Number(draft.psiPercent);
  const availablePercent = Number(draft.availablePercent);
  if (!(psiPercent >= 1 && psiPercent <= 100)) return "The pressure threshold must be between 1 and 100.";
  if (!(availablePercent >= 1 && availablePercent <= 90)) return "The available RAM threshold must be between 1 and 90.";
  const badMounts = invalidMounts(parseList(draft.mounts));
  if (badMounts.length > 0) return `Mounts must be absolute or ~/ paths: ${badMounts.join(", ")}`;
  const badNames = invalidEnvNames(parseList(draft.envNames));
  if (badNames.length > 0) return `Not variables you can forward: ${badNames.join(", ")}`;
  return {
    ...base,
    enabledAgents: draft.enabledAgents,
    allowImageDownloads: draft.allowImageDownloads,
    routeClaudeAgents: draft.routeClaudeAgents,
    gsdPath: draft.gsdPath,
    isolation: draft.isolation,
    memoryPercent,
    memoryFloorGiB,
    cpus,
    dockerDiskGiB,
    githubHttps: draft.githubHttps,
    memoryAlert: { psiPercent, availablePercent },
    template: draft.template,
    mounts: parseList(draft.mounts),
    claudeShared: parseList(draft.claudeShared),
    envFile: draft.envFile.trim(),
    envNames: parseList(draft.envNames),
    networkAllow: parseList(draft.networkAllow),
    forwardPorts: parsePortList(draft.forwardPorts),
    excludedPaths: parseList(draft.excludedPaths),
  };
}

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(sandboxSettings);
  if (settings.status === "loading") return null;
  if (settings.status !== "ready") {
    return (
      <View style={{ gap: 12 }}>
        <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
        {settings.status === "invalid" ? (
          <SettingsCard>
            <SettingsAction label="Stored settings are invalid" actionLabel="Reset" onPress={() => void settings.reset()} />
          </SettingsCard>
        ) : null}
      </View>
    );
  }
  return <SettingsForm key={settings.revision} settings={settings} theme={theme} />;
}

type ReadySettings = Extract<ReturnType<typeof useSettings<typeof sandboxSettings.schema>>, { status: "ready" }>;

function SettingsForm({ settings, theme }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const [draft, setDraft] = useState(() => toDraft(settings.values));
  const templates = useTemplates();
  const templateOptions = [
    { label: "sbx image", value: "" },
    ...(templates.data?.templates ?? [])
      .filter((template) => !template.base)
      .map((template) => ({ label: template.ref.replace(/^docker\.io\/library\//, ""), value: template.ref })),
  ];
  if (draft.template && !templateOptions.some((option) => option.value === draft.template)) {
    templateOptions.push({ label: `${draft.template} (missing)`, value: draft.template });
  }
  const [error, setError] = useState<string | null>(null);
  const update = <Key extends keyof Draft>(key: Key) => (value: Draft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function save() {
    const next = fromDraft(draft, settings.values);
    if (typeof next === "string") {
      setError(next);
      return;
    }
    setError(null);
    await settings.save(next, settings.revision);
  }

  return (
    <View style={{ gap: 24 }}>
      <SettingsSection title="Agents">
        <SettingsCard>
          {AGENT_IDS.map((agent) => (
            <SettingsSwitch
              key={agent}
              label={AGENTS[agent].label}
              hint="Adds it to the + menu. Set it up in Docker Sandboxes → Agents; turning it off keeps its agents."
              value={draft.enabledAgents.includes(agent)}
              onValueChange={(on) =>
                setDraft((current) => ({
                  ...current,
                  enabledAgents: on
                    ? AGENT_IDS.filter((id) => id === agent || current.enabledAgents.includes(id))
                    : current.enabledAgents.filter((id) => id !== agent),
                }))
              }
            />
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Downloads">
        <SettingsCard>
          <SettingsSwitch
            label="Allow downloading sbx images"
            hint={DOWNLOAD_TERMS}
            value={draft.allowImageDownloads}
            onValueChange={update("allowImageDownloads")}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Routing">
        <SettingsCard>
          <SettingsSwitch
            label="Run new Claude agents in sandboxes"
            hint="New agents created with the Claude provider use claude-sbx instead, except in excluded paths."
            value={draft.routeClaudeAgents}
            onValueChange={update("routeClaudeAgents")}
          />
          <SettingsSelect
            label="One sandbox per"
            hint="Workspaces that share a directory get separate sandboxes in workspace mode."
            value={draft.isolation}
            options={[
              { label: "Workspace", value: "workspace" },
              { label: "Directory", value: "directory" },
            ]}
            onValueChange={update("isolation")}
          />
          <SettingsInput
            label="Excluded paths"
            hint="Comma-separated. Agents under these paths keep the Claude provider."
            initialValue={draft.excludedPaths}
            onChangeText={update("excludedPaths")}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Resources">
        <SettingsCard>
          <SettingsInput
            label="Memory per sandbox (% of host RAM)"
            initialValue={draft.memoryPercent}
            onChangeText={update("memoryPercent")}
          />
          <SettingsInput label="Minimum memory (GiB)" initialValue={draft.memoryFloorGiB} onChangeText={update("memoryFloorGiB")} />
          <SettingsInput
            label="CPUs (0 = all)"
            hint="A repository can pick its own in its Sandbox dashboard."
            initialValue={draft.cpus}
            onChangeText={update("cpus")}
          />
          <SettingsInput
            label="Docker disk per sandbox (GiB)"
            hint="The VM's /var/lib/docker: images, containers and their data. 0 uses sbx's 10 GB. The host only spends what a sandbox fills."
            initialValue={draft.dockerDiskGiB}
            onChangeText={update("dockerDiskGiB")}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Memory alerts">
        <SettingsCard>
          <SettingsInput
            label="Alert at memory pressure (%)"
            hint="The host's memory PSI over the last minute. The Docker Sandboxes screen raises an alert at or above it."
            initialValue={draft.psiPercent}
            onChangeText={update("psiPercent")}
          />
          <SettingsInput
            label="Alert below available RAM (%)"
            hint="Share of the host's RAM still available."
            initialValue={draft.availablePercent}
            onChangeText={update("availablePercent")}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Template and mounts">
        <SettingsCard>
          <SettingsSelect
            label="Default template"
            hint="New sandboxes start from it unless their repository picks another in its Sandbox dashboard, under Template."
            value={draft.template}
            options={templateOptions}
            onValueChange={update("template")}
          />
          <SettingsInput
            label="Extra mounts"
            hint="For every repository. Comma-separated absolute or ~/ paths; append :ro for read-only. Paths under your home also appear under the agent's home. Shared tool state and credentials go here; install tools in a template instead."
            initialValue={draft.mounts}
            placeholder="~/.config/gh:ro"
            onChangeText={update("mounts")}
          />
          <SettingsSwitch
            label="Mount GSD Path"
            hint="In repositories that use GSD Path: ~/.gsd-path and the member checkouts in .project/MEMBERS.md, writable."
            value={draft.gsdPath}
            onValueChange={update("gsdPath")}
          />
          <SettingsInput
            label="Shared Claude config items"
            hint="From your Claude config dir into each sandbox's own: folders linked read-only, files copied at every session. Each sandbox keeps its own settings.json; your login reaches it from the env of yours."
            initialValue={draft.claudeShared}
            onChangeText={update("claudeShared")}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Variables">
        <SettingsCard>
          <SettingsInput
            label="Forwarded variables"
            hint="For every repository. Variables your agents get from your shell profile. Values come from the variables file, then the daemon environment."
            initialValue={draft.envNames}
            placeholder="MY_LICENSE_KEY, OTHER_TOKEN"
            onChangeText={update("envNames")}
          />
          <SettingsInput
            label="Variables file"
            hint="Where forwarded values come from: the daemon does not load your shell profile. dotenv format, and export NAME=value lines work, so your shell's env file can serve. Empty uses ~/.config/paseo-sbx/env."
            initialValue={draft.envFile}
            onChangeText={update("envFile")}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Git">
        <SettingsCard>
          <SettingsSwitch
            label="GitHub over HTTPS"
            hint="git in the sandbox reaches GitHub SSH remotes over HTTPS, where the sbx proxy signs in with the secret from sbx secret set github. Sandboxes have no SSH keys."
            value={draft.githubHttps}
            onValueChange={update("githubHttps")}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Network">
        <SettingsCard>
          <SettingsInput
            label="Allowed destinations"
            hint="sbx network policy rules per sandbox. ** allows everything."
            initialValue={draft.networkAllow}
            onChangeText={update("networkAllow")}
          />
          <SettingsInput
            label="Extra host ports"
            hint="Host loopback ports relayed into every sandbox. Paseo's MCP port and loopback API URLs are detected automatically."
            initialValue={draft.forwardPorts}
            onChangeText={update("forwardPorts")}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsCard>
        <SettingsRow label="Template, mounts, memory, CPUs and Docker disk apply to sandboxes created afterwards. Recreate a sandbox from its workspace panel to apply them; variables reach the next session." />
        <SettingsAction
          label={error ?? settings.saveError ?? "Save settings"}
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={settings.saving}
          onPress={() => void save()}
        />
      </SettingsCard>
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    </View>
  );
}
