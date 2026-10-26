import { useRpc, usePaseo, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { finishTemplateRpc, prepareTemplateRpc, shellCommandRpc, type BoundAgentInfo } from "../shared/rpc";
import { TEMPLATE_TAG_PATTERN } from "../shared/spec";
import {
  useArchiveAgent,
  useInvalidateAll,
  useRepoSettings,
  useSandboxAction,
  useSandboxDescription,
  useSaveTemplate,
  useStatus,
  useTemplates,
} from "./queries";
import { Button, Card, ConfirmButton, Row, Screen, Section, errorMessage, formatMiB, useStyles, type Styles } from "./ui";

type Description = NonNullable<ReturnType<typeof useSandboxDescription>["data"]>;

interface Shell {
  name: string;
  command: string;
  args: string[];
}

function useOpenTerminal(workspaceId: string) {
  const paseo = usePaseo();
  return (shell: Shell) =>
    paseo.terminals.create({ workspaceId, name: `sbx ${shell.name}`, command: shell.command, args: shell.args });
}

export function WorkspacePanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme, layout.compact);
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const description = useSandboxDescription(workspaceId, directory);
  const action = useSandboxAction();
  const invalidate = useInvalidateAll();
  const openTerminal = useOpenTerminal(workspaceId);
  const getShell = useRpc(shellCommandRpc);
  const openShell = useMutation({
    mutationFn: async () => openTerminal(await getShell({ workspaceId, directory: directory ?? "" })),
    onSettled: invalidate,
  });

  if (directory === null) {
    return (
      <Screen styles={styles}>
        <Text style={styles.muted}>Workspace not found.</Text>
      </Screen>
    );
  }
  const data = description.data;

  return (
    <Screen styles={styles}>
      <Section styles={styles} title="Sandbox">
        {description.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
        {description.error ? <Text style={styles.error}>{errorMessage(description.error)}</Text> : null}
        {data ? (
          <Card styles={styles}>
            <Row styles={styles} label="Name" first>
              <Text style={styles.mono}>{data.name}</Text>
            </Row>
            <Row styles={styles} label="Status">
              {data.status ?? "not created"}
            </Row>
            <Row styles={styles} label="Repository">
              {data.repoName}
            </Row>
            <Row styles={styles} label="Template">
              <Text style={styles.mono}>{data.template.sandbox ?? (data.status ? "sbx image" : "-")}</Text>
            </Row>
            <Row styles={styles} label="Memory">
              {data.rssMiB === null ? `limit ${formatMiB(data.memoryMiB)}` : `${formatMiB(data.rssMiB)} of ${formatMiB(data.memoryMiB)}`}
            </Row>
          </Card>
        ) : null}
        {data ? <TemplateDivergence styles={styles} data={data} /> : null}
        <View style={styles.actions}>
          <Button
            styles={styles}
            label={data?.status ? "Open shell in sandbox" : "Create now and open shell"}
            primary
            disabled={openShell.isPending}
            onPress={() => openShell.mutate()}
          />
          {data?.status ? (
            <>
              <Button
                styles={styles}
                label="Stop"
                disabled={action.isPending || data.status !== "running"}
                onPress={() => action.mutate({ name: data.name, action: "stop" })}
              />
              <ConfirmButton
                styles={styles}
                label="Recreate"
                confirmLabel="Confirm recreate"
                disabled={action.isPending || data.recreateBlockers.length > 0}
                onConfirm={() => action.mutate({ name: data.name, action: "recreate" })}
              />
              <ConfirmButton
                styles={styles}
                label="Remove"
                confirmLabel="Confirm remove"
                disabled={action.isPending}
                onConfirm={() => action.mutate({ name: data.name, action: "remove" })}
              />
            </>
          ) : null}
        </View>
        {data?.status ? (
          <Text style={styles.muted}>
            {data.recreateBlockers.length > 0
              ? `Recreate needs every agent of this sandbox archived: ${data.recreateBlockers.join("; ")}.`
              : "Recreate removes the VM, with the containers and data inside it, and creates it again with the repo's current template, mounts and memory. Transcripts stay."}
          </Text>
        ) : null}
        {openShell.isPending || action.isPending ? <Text style={styles.muted}>Working on the sandbox…</Text> : null}
        {action.data?.graceful === false ? (
          <Text style={styles.muted}>Stopped without shutting its Docker down first: databases recover on the next start.</Text>
        ) : null}
        {openShell.error ? <Text style={styles.error}>{errorMessage(openShell.error)}</Text> : null}
        {action.error ? <Text style={styles.error}>{errorMessage(action.error)}</Text> : null}
      </Section>

      {data && data.agents.length > 0 ? <AgentsSection styles={styles} agents={data.agents} /> : null}
      {data ? <TemplateSection styles={styles} data={data} workspaceId={workspaceId} directory={directory} /> : null}
      {data ? (
        // Keyed so a different repo or a saved value starts from a fresh draft.
        <MemoryOverride key={`${data.repoKey}:${data.repoMemoryGiB ?? ""}`} styles={styles} data={data} />
      ) : null}

      {data ? (
        <Section styles={styles} title="Mounts">
          <Card styles={styles}>
            {data.mounts.map((mount, index) => (
              <View key={mount} style={[styles.row, index === 0 ? styles.firstRow : null]}>
                <Text style={styles.mono}>{mount}</Text>
              </View>
            ))}
          </Card>
          <Text style={styles.muted}>Mounts are fixed when the sandbox is created.</Text>
        </Section>
      ) : null}

      {data && data.env.length > 0 ? (
        <Section styles={styles} title="Forwarded variables">
          <Card styles={styles}>
            {data.env.map((entry, index) => (
              <Row key={entry.name} styles={styles} label={entry.name} first={index === 0}>
                {entry.present ? "set" : "missing"}
              </Row>
            ))}
          </Card>
        </Section>
      ) : null}

      {data && data.siblings.length > 0 ? (
        <Section styles={styles} title="Other sandboxes of this repository">
          <Card styles={styles}>
            {data.siblings.map((name, index) => (
              <View key={name} style={[styles.row, index === 0 ? styles.firstRow : null]}>
                <Text style={styles.mono}>{name}</Text>
              </View>
            ))}
          </Card>
        </Section>
      ) : null}
    </Screen>
  );
}

function TemplateDivergence({ styles, data }: { styles: Styles; data: Description }) {
  const { template } = data;
  if (template.status === "diverged") {
    return (
      <Text style={styles.error}>
        {`This sandbox was created from ${template.sandbox ?? "the sbx image"}; the repository now uses ${template.configured ?? "the sbx image"}. Recreate it to apply.`}
      </Text>
    );
  }
  if (template.status === "unknown") {
    return <Text style={styles.muted}>The template this sandbox was created from is unknown.</Text>;
  }
  return null;
}

function agentState(agent: BoundAgentInfo): string {
  if (agent.archived) return "archived";
  if (agent.activeTurn) return "working";
  return `idle (${agent.status})`;
}

function AgentsSection({ styles, agents }: { styles: Styles; agents: BoundAgentInfo[] }) {
  const archive = useArchiveAgent();
  return (
    <Section styles={styles} title="Agents in this sandbox">
      <Card styles={styles}>
        {agents.map((agent, index) => (
          <View key={agent.id} style={[styles.row, index === 0 ? styles.firstRow : null]}>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.label}>{agent.title ?? agent.id}</Text>
              <Text style={styles.muted}>{agentState(agent)}</Text>
            </View>
            {agent.archived ? null : (
              <ConfirmButton
                styles={styles}
                label="Archive"
                confirmLabel="Confirm archive"
                disabled={archive.isPending}
                onConfirm={() => archive.mutate(agent.id)}
              />
            )}
          </View>
        ))}
      </Card>
      <Text style={styles.muted}>Idle agents keep the VM running. Archiving the last one lets it stop on its own.</Text>
      {archive.error ? <Text style={styles.error}>{errorMessage(archive.error)}</Text> : null}
    </Section>
  );
}

function defaultTag(repoName: string): string {
  const slug = repoName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "template";
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${slug}:${stamp}`;
}

function TemplateSection({
  styles,
  data,
  workspaceId,
  directory,
}: {
  styles: Styles;
  data: Description;
  workspaceId: string;
  directory: string;
}) {
  const templates = useTemplates();
  const { repo, save, settings } = useRepoSettings(data.repoKey);
  const action = useSandboxAction();
  const saveTemplate = useSaveTemplate();
  const invalidate = useInvalidateAll();
  const openTerminal = useOpenTerminal(workspaceId);
  const prepareRpc = useRpc(prepareTemplateRpc);
  const finishRpc = useRpc(finishTemplateRpc);
  const prepare = useMutation({
    mutationFn: async () => openTerminal(await prepareRpc({ workspaceId, directory })),
    onSettled: invalidate,
  });
  const finish = useMutation({
    mutationFn: (input: { name: string; tag: string }) => finishRpc(input),
    onSettled: invalidate,
  });
  const [selectError, setSelectError] = useState<string | null>(null);

  const globalTemplate = settings.status === "ready" ? settings.values.template : "";
  const custom = (templates.data?.templates ?? []).filter((template) => !template.base);
  const options = [
    { label: globalTemplate ? `Default (${globalTemplate})` : "Default (sbx image)", value: "" },
    ...custom.map((template) => ({ label: template.ref.replace(/^docker\.io\/library\//, ""), value: template.ref })),
  ];
  if (repo?.template && !options.some((option) => option.value === repo.template)) {
    options.push({ label: `${repo.template} (missing)`, value: repo.template });
  }

  return (
    <Section styles={styles} title="Template">
      {repo ? (
        <Card styles={styles}>
          <SettingsSelect
            label="Template for this repository"
            hint="New sandboxes of every worktree of the repository start from it."
            value={repo.template}
            options={options}
            onValueChange={(value) => {
              setSelectError(null);
              save({ template: value }).catch((error: unknown) => setSelectError(errorMessage(error)));
            }}
          />
        </Card>
      ) : null}
      {selectError ? <Text style={styles.error}>{selectError}</Text> : null}

      {data.templatePrep ? (
        <>
          <Text style={styles.muted}>
            {`Preparation sandbox ${data.templatePrep}: install your tools from its shell, then save it as a template.`}
          </Text>
          <View style={styles.actions}>
            <Button styles={styles} label="Open preparation shell" disabled={prepare.isPending} onPress={() => prepare.mutate()} />
            <ConfirmButton
              styles={styles}
              label="Discard preparation"
              confirmLabel="Confirm discard"
              disabled={action.isPending}
              onConfirm={() => action.mutate({ name: data.templatePrep ?? "", action: "remove" })}
            />
          </View>
          <SaveTemplateForm
            styles={styles}
            repoName={data.repoName}
            pending={finish.isPending}
            error={finish.error}
            submitLabel="Save preparation as template"
            onSubmit={async (tag, useForRepo) => {
              const { ref } = await finish.mutateAsync({ name: data.templatePrep ?? "", tag });
              if (useForRepo) await save({ template: ref });
            }}
          />
        </>
      ) : (
        <>
          <View style={styles.actions}>
            <Button styles={styles} label="Prepare template" primary disabled={prepare.isPending} onPress={() => prepare.mutate()} />
          </View>
          <Text style={styles.muted}>
            Opens a shell in a clean sandbox, without your variables or credentials, to install tools and save as a template.
          </Text>
        </>
      )}
      {prepare.isPending ? <Text style={styles.muted}>Preparing the sandbox…</Text> : null}
      {prepare.error ? <Text style={styles.error}>{errorMessage(prepare.error)}</Text> : null}

      {data.status ? (
        <SaveTemplateForm
          styles={styles}
          repoName={data.repoName}
          pending={saveTemplate.isPending}
          error={saveTemplate.error}
          submitLabel="Save this sandbox as template"
          warning="The template captures this sandbox's whole filesystem, including /home/agent: shell history, caches and any login tokens stored there."
          onSubmit={async (tag, useForRepo) => {
            const { ref } = await saveTemplate.mutateAsync({ name: data.name, tag });
            if (useForRepo) await save({ template: ref });
          }}
        />
      ) : null}
    </Section>
  );
}

function SaveTemplateForm({
  styles,
  repoName,
  pending,
  error,
  submitLabel,
  warning,
  onSubmit,
}: {
  styles: Styles;
  repoName: string;
  pending: boolean;
  error: unknown;
  submitLabel: string;
  warning?: string;
  onSubmit(tag: string, useForRepo: boolean): Promise<void>;
}) {
  const [tag, setTag] = useState(() => defaultTag(repoName));
  const [useForRepo, setUseForRepo] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const invalid = !TEMPLATE_TAG_PATTERN.test(tag.trim());
  return (
    <>
      <Card styles={styles}>
        <SettingsInput
          label="Template tag"
          hint="name:tag, lowercase."
          initialValue={tag}
          error={invalid ? "Use lowercase letters, digits, . _ - and an optional :tag" : undefined}
          onChangeText={setTag}
        />
        <SettingsSwitch label="Use for this repository" value={useForRepo} onValueChange={setUseForRepo} />
      </Card>
      {warning ? <Text style={styles.muted}>{warning}</Text> : null}
      <View style={styles.actions}>
        <Button
          styles={styles}
          label={pending ? "Saving…" : submitLabel}
          disabled={pending || invalid}
          onPress={() => {
            setSubmitError(null);
            onSubmit(tag.trim(), useForRepo).catch((caught: unknown) => setSubmitError(errorMessage(caught)));
          }}
        />
      </View>
      {submitError ?? (error ? errorMessage(error) : null) ? (
        <Text style={styles.error}>{submitError ?? errorMessage(error)}</Text>
      ) : null}
    </>
  );
}

function MemoryOverride({ styles, data }: { styles: Styles; data: Description }) {
  const { repo, save, settings } = useRepoSettings(data.repoKey);
  const status = useStatus();
  const [draft, setDraft] = useState(data.repoMemoryGiB === null ? "" : String(data.repoMemoryGiB));
  if (!repo || settings.status !== "ready") return null;

  const maxGiB = status.data ? Math.floor((status.data.hostMemoryMiB * 0.75) / 102.4) / 10 : null;
  const value = draft.trim() === "" ? null : Number(draft);
  const invalid =
    value !== null && !(Number.isFinite(value) && value >= 0.5 && (maxGiB === null || value <= maxGiB));

  return (
    <Section styles={styles} title="Memory for this repository">
      <Card styles={styles}>
        <SettingsInput
          label="Memory (GiB)"
          hint="Empty uses the default. Applies to sandboxes created afterwards: recreate to apply it here."
          initialValue={draft}
          placeholder="default"
          error={invalid ? `Enter a number from 0.5${maxGiB === null ? "" : ` to ${maxGiB}`}` : settings.saveError}
          onChangeText={setDraft}
        />
      </Card>
      <View style={styles.actions}>
        <Button
          styles={styles}
          label="Save"
          primary
          disabled={invalid || settings.saving}
          onPress={() => void save({ memoryGiB: value ?? undefined })}
        />
      </View>
    </Section>
  );
}
