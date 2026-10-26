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
import { sandboxSettings, type IsolationMode, type SandboxSettings } from "../shared/settings";
import { parseList, parsePortList } from "../shared/spec";
import { useTemplates } from "./queries";

interface Draft {
  routeClaudeAgents: boolean;
  isolation: IsolationMode;
  memoryPercent: string;
  memoryFloorGiB: string;
  cpus: string;
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
    routeClaudeAgents: values.routeClaudeAgents,
    isolation: values.isolation,
    memoryPercent: String(values.memoryPercent),
    memoryFloorGiB: String(values.memoryFloorGiB),
    cpus: String(values.cpus),
    template: values.template,
    mounts: values.mounts.join("\n"),
    claudeShared: values.claudeShared.join(", "),
    envFile: values.envFile,
    envNames: values.envNames.join(", "),
    networkAllow: values.networkAllow.join(", "),
    forwardPorts: values.forwardPorts.join(", "),
    excludedPaths: values.excludedPaths.join("\n"),
  };
}

function fromDraft(draft: Draft, base: SandboxSettings): SandboxSettings | string {
  const memoryPercent = Number(draft.memoryPercent);
  const memoryFloorGiB = Number(draft.memoryFloorGiB);
  const cpus = Number(draft.cpus);
  if (!(memoryPercent >= 1 && memoryPercent <= 90)) return "Memory percent must be between 1 and 90.";
  if (!(memoryFloorGiB >= 1)) return "Memory floor must be at least 1 GiB.";
  if (!(Number.isInteger(cpus) && cpus >= 0)) return "CPUs must be a whole number (0 = all).";
  return {
    ...base,
    routeClaudeAgents: draft.routeClaudeAgents,
    isolation: draft.isolation,
    memoryPercent,
    memoryFloorGiB,
    cpus,
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
    { label: "sbx image for Claude", value: "" },
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
            hint="One per line. Agents under these paths keep the Claude provider."
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
          <SettingsInput label="CPUs (0 = all)" initialValue={draft.cpus} onChangeText={update("cpus")} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Environment">
        <SettingsCard>
          <SettingsSelect
            label="Default template"
            hint="New sandboxes start from it unless their repository picks another in its Sandbox panel."
            value={draft.template}
            options={templateOptions}
            onValueChange={update("template")}
          />
          <SettingsInput
            label="Extra mounts"
            hint="One per line, absolute or ~/ paths. Append :ro for read-only. Toolchains and shared tool state go here."
            initialValue={draft.mounts}
            placeholder="~/.gsd-path"
            onChangeText={update("mounts")}
          />
          <SettingsInput
            label="Shared Claude config items"
            hint="Linked read-only from your Claude config dir into each sandbox's own config dir."
            initialValue={draft.claudeShared}
            onChangeText={update("claudeShared")}
          />
          <SettingsInput
            label="Forwarded variables"
            hint="Variables your agents get from your shell profile. Values come from the variables file, then the daemon environment."
            initialValue={draft.envNames}
            placeholder="MY_LICENSE_KEY, OTHER_TOKEN"
            onChangeText={update("envNames")}
          />
          <SettingsInput
            label="Variables file"
            hint="dotenv format. Empty uses ~/.config/paseo-sbx/env."
            initialValue={draft.envFile}
            onChangeText={update("envFile")}
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
        <SettingsRow label="Changes to mounts, memory and CPUs apply to sandboxes created afterwards." />
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
