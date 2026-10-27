import { useRpc, usePaseo, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  finishTemplateRpc,
  prepareTemplateRpc,
  publishPortRpc,
  shellCommandRpc,
  refResultSchema,
  shellResultSchema,
  unpublishPortRpc,
  type BoundAgentInfo,
} from "../shared/rpc";
import {
  TEMPLATE_TAG_PATTERN,
  invalidEnvNames,
  invalidMounts,
  parseList,
  type MountSource,
} from "../shared/spec";
import {
  useArchiveAgent,
  useAwaitOperation,
  useInvalidateAll,
  useRepoSettings,
  useSandboxAction,
  useSandboxDescription,
  useSaveTemplate,
  useStatus,
  useTemplates,
} from "./queries";
import {
  Button,
  Card,
  ConfirmButton,
  Row,
  Screen,
  Section,
  agentState,
  errorMessage,
  formatMiB,
  shortRef,
  useStyles,
  type Styles,
} from "./ui";

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
  const awaitOperation = useAwaitOperation();
  const openShell = useMutation({
    mutationFn: async () =>
      openTerminal(shellResultSchema.parse(await awaitOperation(await getShell({ workspaceId, directory: directory ?? "" })))),
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
              <Text style={styles.mono}>{data.template.sandbox ? shortRef(data.template.sandbox) : data.status ? "sbx image" : "-"}</Text>
            </Row>
            <Row styles={styles} label="Memory">
              {data.rssMiB === null ? `limit ${formatMiB(data.memoryMiB)}` : `${formatMiB(data.rssMiB)} of ${formatMiB(data.memoryMiB)}`}
            </Row>
          </Card>
        ) : null}
        {data ? <TemplateDivergence styles={styles} data={data} /> : null}
        {data?.operations.map((operation) =>
          operation.status === "running" ? (
            <Text key={operation.id} style={styles.muted}>{`${operation.kind} of ${operation.target} in progress…`}</Text>
          ) : operation.status === "failed" ? (
            <Text key={operation.id} style={styles.error}>{`${operation.kind} of ${operation.target} failed: ${operation.error ?? ""}`}</Text>
          ) : null,
        )}
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
              : "Recreate removes the VM, with the containers and data inside it, and creates it again with the repo's current template, mounts and resources. Transcripts stay."}
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
      {data ? <ServicesSection styles={styles} data={data} compact={layout.compact} /> : null}
      {data ? <TemplateSection styles={styles} data={data} workspaceId={workspaceId} directory={directory} /> : null}
      {data ? (
        // Keyed so a different repo or a saved value starts from a fresh draft.
        <ResourcesOverride
          key={`${data.repoKey}:${data.repoMemoryGiB ?? ""}:${data.repoCpus ?? ""}`}
          styles={styles}
          data={data}
        />
      ) : null}

      {data ? <MountsSection styles={styles} data={data} /> : null}
      {data?.gsdPath ? <GsdPathSection styles={styles} gsdPath={data.gsdPath} /> : null}
      {data ? <VariablesSection styles={styles} data={data} /> : null}

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
        {`This sandbox was created from ${template.sandbox ? shortRef(template.sandbox) : "the sbx image"}; the repository now uses ${template.configured ? shortRef(template.configured) : "the sbx image"}. Recreate it to apply.`}
      </Text>
    );
  }
  if (template.status === "unknown") {
    return <Text style={styles.muted}>The template this sandbox was created from is unknown.</Text>;
  }
  return null;
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

function formatAge(at: number): string {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - at));
  return seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

function hostBinding(publication: Description["services"]["publications"][number]): string {
  if (publication.hostPort === null) return "not published";
  return publication.allInterfaces ? `port ${publication.hostPort} on every host address` : `127.0.0.1:${publication.hostPort}`;
}

function ServicesSection({ styles, data, compact }: { styles: Styles; data: Description; compact: boolean }) {
  const invalidate = useInvalidateAll();
  const publishRpc = useRpc(publishPortRpc);
  const unpublishRpc = useRpc(unpublishPortRpc);
  const awaitOperation = useAwaitOperation();
  const publish = useMutation({
    mutationFn: async (input: { guestPort: number; allInterfaces: boolean; hostPort: number | null }) =>
      awaitOperation(await publishRpc({ name: data.name, ...input })),
    onSettled: invalidate,
  });
  const unpublish = useMutation({
    mutationFn: async (guestPort: number) => awaitOperation(await unpublishRpc({ name: data.name, guestPort })),
    onSettled: invalidate,
  });
  const { repo, save } = useRepoSettings(data.repoKey);
  const [allInterfaces, setAllInterfaces] = useState(false);
  const [manualPort, setManualPort] = useState("");
  const [hostPort, setHostPort] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  const { services } = data;
  const running = data.status === "running";
  const published = new Set(services.publications.map((publication) => publication.guestPort));
  const parsedManual = Number(manualPort);
  const parsedHost = hostPort.trim() === "" ? null : Number(hostPort);
  const validPort = (value: number) => Number.isInteger(value) && value > 0 && value < 65536;
  const hostInvalid = parsedHost !== null && !validPort(parsedHost);
  const publishLabel = running ? "Publish" : "Publish (starts the VM)";

  function toggleAuto(guestPort: number, enabled: boolean) {
    if (!repo) return;
    const autoPublish = enabled
      ? [...new Set([...repo.autoPublish, guestPort])]
      : repo.autoPublish.filter((port) => port !== guestPort);
    setRepoError(null);
    save({ autoPublish }).catch((error: unknown) => setRepoError(errorMessage(error)));
  }

  if (!data.status) {
    return (
      <Section styles={styles} title="Services">
        <Text style={styles.muted}>Services show up once the sandbox exists.</Text>
      </Section>
    );
  }

  return (
    <Section styles={styles} title="Services">
      <Text style={styles.muted}>
        {services.snapshotAt === null
          ? "No report of listening ports yet: it starts with the next agent or shell."
          : running
            ? `Listening ports in the VM, reported ${formatAge(services.snapshotAt)}.`
            : `The VM is stopped; ports as of ${formatAge(services.snapshotAt)}.`}
      </Text>
      {services.listeners.length > 0 ? (
        <Card styles={styles}>
          {services.listeners.map((listener, index) => (
            <View key={listener.port} style={[styles.row, index === 0 ? styles.firstRow : null]}>
              <View style={{ flexShrink: 1 }}>
                <Text style={styles.label}>{`Port ${listener.port}`}</Text>
                <Text style={styles.muted}>{listener.addresses.join(", ")}</Text>
              </View>
              {published.has(listener.port) ? (
                <Text style={styles.value}>published</Text>
              ) : (
                <Button
                  styles={styles}
                  label={publishLabel}
                  disabled={publish.isPending || hostInvalid}
                  onPress={() => publish.mutate({ guestPort: listener.port, allInterfaces, hostPort: parsedHost })}
                />
              )}
            </View>
          ))}
        </Card>
      ) : null}

      <Card styles={styles}>
        <SettingsSwitch
          label="Listen on every host address"
          hint="Off publishes on 127.0.0.1 only. On, anyone who reaches this host can open the service, without authentication."
          value={allInterfaces}
          onValueChange={setAllInterfaces}
        />
        <SettingsInput
          label="Fixed host port"
          hint="Empty picks a free one. Either way the port stays the same when the VM restarts."
          initialValue={hostPort}
          placeholder="any"
          error={hostInvalid ? "Enter a port from 1 to 65535" : undefined}
          onChangeText={setHostPort}
        />
        <SettingsInput label="Guest port" hint="Publish a port before its service starts." initialValue={manualPort} placeholder="5173" onChangeText={setManualPort} />
      </Card>
      <View style={styles.actions}>
        <Button
          styles={styles}
          label={publishLabel}
          disabled={publish.isPending || !validPort(parsedManual) || hostInvalid}
          onPress={() => publish.mutate({ guestPort: parsedManual, allInterfaces, hostPort: parsedHost })}
        />
      </View>

      {services.publications.length > 0 ? (
        <Card styles={styles}>
          {services.publications.map((publication, index) => (
            <View
              key={publication.guestPort}
              style={[styles.row, index === 0 ? styles.firstRow : null, compact ? styles.stackedRow : null]}
            >
              <View style={{ flexShrink: 1 }}>
                <Text style={styles.label}>{`Guest port ${publication.guestPort}`}</Text>
                <Text style={publication.hostPort === null ? styles.error : styles.mono}>{hostBinding(publication)}</Text>
              </View>
              <View style={styles.actions}>
                {repo ? (
                  <Button
                    styles={styles}
                    label={repo.autoPublish.includes(publication.guestPort) ? "Stop auto-publishing" : "Always publish in this repo"}
                    onPress={() => toggleAuto(publication.guestPort, !repo.autoPublish.includes(publication.guestPort))}
                  />
                ) : null}
                <Button
                  styles={styles}
                  label="Unpublish"
                  disabled={unpublish.isPending}
                  onPress={() => unpublish.mutate(publication.guestPort)}
                />
              </View>
            </View>
          ))}
        </Card>
      ) : null}
      {publish.isPending || unpublish.isPending ? <Text style={styles.muted}>Updating the publications…</Text> : null}
      {publish.error ? <Text style={styles.error}>{errorMessage(publish.error)}</Text> : null}
      {unpublish.error ? <Text style={styles.error}>{errorMessage(unpublish.error)}</Text> : null}
      {repoError ? <Text style={styles.error}>{repoError}</Text> : null}
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
  const awaitOperation = useAwaitOperation();
  const prepare = useMutation({
    mutationFn: async () => openTerminal(shellResultSchema.parse(await awaitOperation(await prepareRpc({ workspaceId, directory })))),
    onSettled: invalidate,
  });
  const finish = useMutation({
    mutationFn: async (input: { name: string; tag: string }) => refResultSchema.parse(await awaitOperation(await finishRpc(input))),
    onSettled: invalidate,
  });
  const [selectError, setSelectError] = useState<string | null>(null);
  const [saveWorking, setSaveWorking] = useState(false);

  const globalTemplate = settings.status === "ready" ? settings.values.template : "";
  const custom = (templates.data?.templates ?? []).filter((template) => !template.base);
  const options = [
    { label: globalTemplate ? `Default (${globalTemplate})` : "Default (sbx image)", value: "" },
    ...custom.map((template) => ({ label: shortRef(template.ref), value: template.ref })),
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

      {data.status && !saveWorking ? (
        <View style={styles.actions}>
          <Button styles={styles} label="Save this sandbox as template…" onPress={() => setSaveWorking(true)} />
        </View>
      ) : null}
      {data.status && saveWorking ? (
        <SaveTemplateForm
          styles={styles}
          repoName={data.repoName}
          pending={saveTemplate.isPending}
          error={saveTemplate.error}
          submitLabel="Save this sandbox as template"
          warning="Saving stops this sandbox, and needs every agent in it archived. The template captures its whole filesystem, including /home/agent: shell history, caches and any login tokens stored there."
          onSubmit={async (tag, useForRepo) => {
            const { ref } = await saveTemplate.mutateAsync({ name: data.name, tag });
            if (useForRepo) await save({ template: ref });
            setSaveWorking(false);
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

function ResourcesOverride({ styles, data }: { styles: Styles; data: Description }) {
  const { repo, save, settings } = useRepoSettings(data.repoKey);
  const status = useStatus();
  const [memoryDraft, setMemoryDraft] = useState(data.repoMemoryGiB === null ? "" : String(data.repoMemoryGiB));
  const [cpusDraft, setCpusDraft] = useState(data.repoCpus === null ? "" : String(data.repoCpus));
  if (!repo || settings.status !== "ready") return null;

  const maxGiB = status.data ? Math.floor((status.data.hostMemoryMiB * 0.75) / 102.4) / 10 : null;
  const memory = memoryDraft.trim() === "" ? null : Number(memoryDraft);
  const memoryInvalid =
    memory !== null && !(Number.isFinite(memory) && memory >= 0.5 && (maxGiB === null || memory <= maxGiB));
  const hostCpus = status.data?.hostCpus ?? null;
  const cpus = cpusDraft.trim() === "" ? null : Number(cpusDraft);
  const cpusInvalid = cpus !== null && !(Number.isInteger(cpus) && cpus >= 0 && (hostCpus === null || cpus <= hostCpus));
  const defaultCpus = settings.values.cpus === 0 ? `all${hostCpus === null ? "" : ` ${hostCpus}`}` : String(settings.values.cpus);

  return (
    <Section styles={styles} title="Resources for this repository">
      <Card styles={styles}>
        <SettingsInput
          label="Memory (GiB)"
          hint="Empty uses the default."
          initialValue={memoryDraft}
          placeholder="default"
          error={memoryInvalid ? `Enter a number from 0.5${maxGiB === null ? "" : ` to ${maxGiB}`}` : null}
          onChangeText={setMemoryDraft}
        />
        <SettingsInput
          label="CPUs"
          hint={`Empty uses the default (${defaultCpus}); 0 is every CPU. Builds start a process per CPU, so with little memory fewer CPUs keep them from running out of it.`}
          initialValue={cpusDraft}
          placeholder="default"
          error={cpusInvalid ? `Enter a whole number from 0${hostCpus === null ? "" : ` to ${hostCpus}`}` : settings.saveError}
          onChangeText={setCpusDraft}
        />
      </Card>
      {data.resourcesApplied === false ? (
        <Text style={styles.error}>The sandbox was created with other resources: recreate it to apply these.</Text>
      ) : (
        <Text style={styles.muted}>Sandboxes get them when created: recreate to apply a change here.</Text>
      )}
      <View style={styles.actions}>
        <Button
          styles={styles}
          label="Save"
          primary
          disabled={memoryInvalid || cpusInvalid || settings.saving}
          onPress={() => void save({ memoryGiB: memory ?? undefined, cpus: cpus ?? undefined })}
        />
      </View>
    </Section>
  );
}

const MOUNT_SOURCE_LABELS: Record<MountSource, string> = {
  settings: "all repositories",
  repo: "this repository",
  "gsd-path": "GSD Path",
  member: "GSD Path member",
  git: "git metadata",
  claude: "shared Claude config",
  agents: "agents' shared homes",
};

function mountNote(mount: Description["mounts"][number]): string {
  const parts = [MOUNT_SOURCE_LABELS[mount.source], mount.readOnly ? "read-only" : "writable"];
  if (!mount.exists) parts.push("missing on the host, skipped");
  else if (mount.applied === false) parts.push("not in the sandbox yet");
  return parts.join(" · ");
}

function MountsSection({ styles, data }: { styles: Styles; data: Description }) {
  const { repo, save, settings } = useRepoSettings(data.repoKey);
  const outdated = data.removedMounts.length > 0 || data.mounts.some((mount) => mount.exists && mount.applied === false);
  return (
    <Section styles={styles} title="Mounts">
      <Card styles={styles}>
        <View style={[styles.row, styles.stackedRow, styles.firstRow]}>
          <Text style={styles.mono}>{data.workspace}</Text>
          <Text style={styles.muted}>workspace · writable</Text>
        </View>
        {data.mounts.map((mount) => (
          <View key={mount.path} style={[styles.row, styles.stackedRow]}>
            <Text style={styles.mono}>{mount.path}</Text>
            <Text style={mount.exists ? styles.muted : styles.error}>{mountNote(mount)}</Text>
          </View>
        ))}
      </Card>
      {data.removedMounts.length > 0 ? (
        <Text style={styles.muted}>{`Still in the sandbox, no longer configured: ${data.removedMounts.join(", ")}.`}</Text>
      ) : null}
      {outdated ? <Text style={styles.error}>Recreate the sandbox to apply the mount changes.</Text> : null}
      {repo && settings.status === "ready" ? (
        // Keyed so a saved value starts a fresh draft.
        <ListEditor
          key={repo.mounts.join("\n")}
          styles={styles}
          label="Mounts for this repository"
          hint="Comma-separated absolute or ~/ paths; append :ro for read-only. Paths under your home also appear under the agent's home. Sandboxes get them when created: recreate to apply here."
          placeholder="~/.config/gh:ro"
          saved={repo.mounts}
          validate={(items) => {
            const invalid = invalidMounts(items);
            return invalid.length > 0 ? `Use absolute or ~/ paths: ${invalid.join(", ")}` : null;
          }}
          saving={settings.saving}
          saveError={settings.saveError}
          onSave={(mounts) => void save({ mounts })}
        />
      ) : null}
    </Section>
  );
}

function GsdPathSection({ styles, gsdPath }: { styles: Styles; gsdPath: NonNullable<Description["gsdPath"]> }) {
  return (
    <Section styles={styles} title="GSD Path members">
      <Card styles={styles}>
        {gsdPath.members.length === 0 ? (
          <View style={[styles.row, styles.firstRow]}>
            <Text style={styles.muted}>.project/MEMBERS.md lists no members.</Text>
          </View>
        ) : (
          gsdPath.members.map((member, index) => (
            <View key={member.name} style={[styles.row, styles.stackedRow, index === 0 ? styles.firstRow : null]}>
              <Text style={styles.label}>{member.name}</Text>
              <Text style={styles.mono}>{member.path}</Text>
              {member.available ? null : <Text style={styles.error}>No checkout at this path on the host.</Text>}
            </View>
          ))
        )}
      </Card>
      <Text style={styles.muted}>
        {gsdPath.enabled
          ? "The sandbox mounts ~/.gsd-path, also in the agent's home, and the member checkouts writable. New worktrees go under your ~/.gsd-path/projects."
          : "GSD Path mounts are off in the plugin settings."}
      </Text>
    </Section>
  );
}

function envNote(entry: Description["env"][number]): string {
  if (entry.reserved) return "kept by sbx, not forwarded";
  return `${entry.present ? "set" : "missing"} · ${entry.scope === "all" ? "all repositories" : "this repository"}`;
}

function VariablesSection({ styles, data }: { styles: Styles; data: Description }) {
  const { repo, save, settings } = useRepoSettings(data.repoKey);
  const status = useStatus();
  const envFile = status.data?.envFile ?? "the variables file";
  return (
    <Section styles={styles} title="Forwarded variables">
      {data.env.length > 0 ? (
        <Card styles={styles}>
          {data.env.map((entry, index) => (
            <Row key={entry.name} styles={styles} label={entry.name} first={index === 0}>
              {envNote(entry)}
            </Row>
          ))}
        </Card>
      ) : null}
      {repo && settings.status === "ready" ? (
        <ListEditor
          key={repo.envNames.join("\n")}
          styles={styles}
          label="Variables for this repository"
          hint={`Comma-separated names. Values come from ${envFile}, then the daemon environment. The next session gets them.`}
          placeholder="MY_LICENSE_KEY, OTHER_TOKEN"
          saved={repo.envNames}
          validate={(items) => {
            const invalid = invalidEnvNames(items);
            return invalid.length > 0 ? `Not variables you can forward: ${invalid.join(", ")}` : null;
          }}
          saving={settings.saving}
          saveError={settings.saveError}
          onSave={(envNames) => void save({ envNames })}
        />
      ) : null}
    </Section>
  );
}

/** A comma-separated list setting of the repository, saved on its own. */
function ListEditor({
  styles,
  label,
  hint,
  placeholder,
  saved,
  validate,
  saving,
  saveError,
  onSave,
}: {
  styles: Styles;
  label: string;
  hint: string;
  placeholder: string;
  saved: readonly string[];
  validate(items: string[]): string | null;
  saving: boolean;
  saveError: string | null;
  onSave(items: string[]): void;
}) {
  const [draft, setDraft] = useState(saved.join(", "));
  const items = parseList(draft);
  const error = validate(items);
  const changed = items.join("\n") !== saved.join("\n");
  return (
    <>
      <Card styles={styles}>
        <SettingsInput
          label={label}
          hint={hint}
          initialValue={draft}
          placeholder={placeholder}
          error={error ?? saveError}
          onChangeText={setDraft}
        />
      </Card>
      <View style={styles.actions}>
        <Button styles={styles} label="Save" primary disabled={error !== null || !changed || saving} onPress={() => onSave(items)} />
      </View>
    </>
  );
}
