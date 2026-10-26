import { useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { SandboxSummary, TemplateSummary } from "../shared/rpc";
import { sandboxSettings } from "../shared/settings";
import {
  useArchiveAgent,
  useEnsureProvider,
  useInvalidateAll,
  useMemory,
  useRemoveTemplate,
  useSandboxAction,
  useSandboxes,
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
  repoPath,
  shortRef,
  useStyles,
  type Styles,
} from "./ui";

interface SandboxesScreenProps extends PluginScreenProps {
  openSettings(): void;
}

export function SandboxesScreen({ theme, layout, openSettings }: SandboxesScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const status = useStatus();
  const sandboxes = useSandboxes();
  const ensureProvider = useEnsureProvider();

  return (
    <Screen styles={styles}>
      <Section styles={styles} title="Docker Sandboxes">
        {status.isPending ? <Text style={styles.muted}>Checking sbx…</Text> : null}
        {status.error ? <Text style={styles.error}>{errorMessage(status.error)}</Text> : null}
        {status.data ? (
          <Card styles={styles}>
            <Row styles={styles} label="sbx" first>
              {status.data.sbx.installed ? (status.data.sbx.version ?? "installed") : "not installed"}
            </Row>
            <Row styles={styles} label="Paseo sandbox daemon">
              {status.data.sbx.daemon}
            </Row>
            <Row styles={styles} label="Provider claude-sbx">
              <View style={styles.actions}>
                <Text style={styles.value}>
                  {status.data.provider.current
                    ? "configured"
                    : status.data.provider.configured
                      ? "outdated"
                      : "not configured"}
                </Text>
                {status.data.provider.current ? null : (
                  <Button
                    styles={styles}
                    label="Configure"
                    primary
                    disabled={ensureProvider.isPending}
                    onPress={() => ensureProvider.mutate()}
                  />
                )}
              </View>
            </Row>
            <Row styles={styles} label="Default memory per sandbox">
              {`${formatMiB(status.data.defaultMemoryMiB)} of ${formatMiB(status.data.hostMemoryMiB)}`}
            </Row>
            <Row styles={styles} label="Forwarded variables file">
              <Text style={styles.mono}>{status.data.envFile}</Text>
            </Row>
          </Card>
        ) : null}
        {status.data?.sbx.error ? <Text style={styles.error}>{status.data.sbx.error}</Text> : null}
        {ensureProvider.error ? <Text style={styles.error}>{errorMessage(ensureProvider.error)}</Text> : null}
        <View style={styles.actions}>
          <Button styles={styles} label="Settings" onPress={openSettings} />
          <Button styles={styles} label="Refresh" onPress={() => void Promise.all([status.refetch(), sandboxes.refetch()])} />
        </View>
      </Section>

      <MemorySection styles={styles} />

      <Section styles={styles} title="Sandboxes">
        {sandboxes.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
        {sandboxes.error ? <Text style={styles.error}>{errorMessage(sandboxes.error)}</Text> : null}
        {sandboxes.data && sandboxes.data.sandboxes.length === 0 ? (
          <Text style={styles.muted}>
            No sandboxes yet. One is created the first time a claude-sbx agent starts in a workspace.
          </Text>
        ) : null}
        {sandboxes.data?.sandboxes.map((sandbox) => (
          <SandboxCard key={sandbox.name} styles={styles} sandbox={sandbox} />
        ))}
      </Section>

      <TemplatesSection styles={styles} />
      <LegacyOverridesSection styles={styles} />
    </Screen>
  );
}

function MemorySection({ styles }: { styles: Styles }) {
  const memory = useMemory();
  const archive = useArchiveAgent();
  const data = memory.data;
  if (memory.error) return <Text style={styles.error}>{errorMessage(memory.error)}</Text>;
  if (!data) return null;
  const holders = data.sandboxes.filter((sandbox) => sandbox.activeAgents.length > 0);
  return (
    <Section styles={styles} title="Memory">
      {data.alerts.length > 0 ? (
        <Text style={styles.error}>{`Memory alert: ${data.alerts.join("; ")}. Archive idle agents to let their VMs stop.`}</Text>
      ) : null}
      <Card styles={styles}>
        <Row styles={styles} label="VMs (resident, estimate)" first>
          {formatMiB(data.vmRssMiB)}
        </Row>
        {data.host ? (
          <>
            <Row styles={styles} label="Host RAM available">
              {`${formatMiB(data.host.availableMiB)} of ${formatMiB(data.host.totalMiB)}`}
            </Row>
            <Row styles={styles} label="Swap in use">
              {formatMiB(data.host.swapUsedMiB)}
            </Row>
            <Row styles={styles} label="Memory pressure (avg 60 s)">
              {data.host.psiSome60 === null ? "unavailable" : `${data.host.psiSome60.toFixed(1)}%`}
            </Row>
          </>
        ) : null}
      </Card>
      {holders.map((sandbox) => (
        <Card key={sandbox.name} styles={styles}>
          <Row styles={styles} label={sandbox.name} first>
            {sandbox.rssMiB === null ? "-" : formatMiB(sandbox.rssMiB)}
          </Row>
          {sandbox.activeAgents.map((agent) => (
            <View key={agent.id} style={styles.row}>
              <View style={{ flexShrink: 1 }}>
                <Text style={styles.label}>{agent.title ?? agent.id}</Text>
                <Text style={styles.muted}>{agentState(agent)}</Text>
              </View>
              {agent.activeTurn ? null : (
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
      ))}
      <Text style={styles.muted}>Agents that are not archived keep their VM running. Archiving the last one lets it stop on its own.</Text>
      {archive.error ? <Text style={styles.error}>{errorMessage(archive.error)}</Text> : null}
    </Section>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function TemplatesSection({ styles }: { styles: Styles }) {
  const templates = useTemplates();
  const remove = useRemoveTemplate();
  const custom = (templates.data?.templates ?? []).filter((template) => !template.base);
  return (
    <Section styles={styles} title="Templates">
      {templates.error ? <Text style={styles.error}>{errorMessage(templates.error)}</Text> : null}
      {templates.data && custom.length === 0 ? (
        <Text style={styles.muted}>No templates yet. Prepare one from a workspace's Sandbox panel.</Text>
      ) : null}
      {custom.map((template) => (
        <TemplateCard key={template.ref} styles={styles} template={template} onRemove={() => remove.mutate(template.ref)} removing={remove.isPending} />
      ))}
      {remove.error ? <Text style={styles.error}>{errorMessage(remove.error)}</Text> : null}
    </Section>
  );
}

function TemplateCard({
  styles,
  template,
  onRemove,
  removing,
}: {
  styles: Styles;
  template: TemplateSummary;
  onRemove(): void;
  removing: boolean;
}) {
  return (
    <Card styles={styles}>
      <Row styles={styles} label={shortRef(template.ref)} first>
        {formatBytes(template.sizeBytes)}
      </Row>
      <Row styles={styles} label="Used by">
        {template.users.length === 0 ? "-" : template.users.map((user) => (user === "default" ? "default" : repoPath(user))).join(", ")}
      </Row>
      <View style={[styles.row, styles.actions]}>
        <ConfirmButton
          styles={styles}
          label="Remove"
          confirmLabel="Confirm remove"
          disabled={removing || template.users.length > 0}
          onConfirm={onRemove}
        />
      </View>
    </Card>
  );
}

function LegacyOverridesSection({ styles }: { styles: Styles }) {
  const settings = useSettings(sandboxSettings);
  const invalidate = useInvalidateAll();
  if (settings.status !== "ready") return null;
  const entries = Object.entries(settings.values.legacyOverrides);
  if (entries.length === 0) return null;
  async function drop(key: string) {
    if (settings.status !== "ready") return;
    const legacyOverrides = { ...settings.values.legacyOverrides };
    delete legacyOverrides[key];
    await settings.save({ ...settings.values, legacyOverrides }, settings.revision);
    invalidate();
  }
  return (
    <Section styles={styles} title="Settings to reassign">
      <Text style={styles.muted}>
        Per-sandbox settings from an older plugin version that could not move to a single repository. Set them again in the
        repository's Sandbox panel, then remove them here.
      </Text>
      {entries.map(([key, override]) => (
        <Card key={key} styles={styles}>
          <Row styles={styles} label={key} first>
            {override.reason === "conflict" ? "conflicts with another worktree" : override.reason === "workspace" ? "per workspace" : "unresolved"}
          </Row>
          <Row styles={styles} label="Values">
            {[
              override.memoryGiB ? `${override.memoryGiB} GiB` : null,
              override.mounts.length > 0 ? `mounts: ${override.mounts.join(", ")}` : null,
              override.envNames.length > 0 ? `variables: ${override.envNames.join(", ")}` : null,
            ]
              .filter(Boolean)
              .join("; ") || "-"}
          </Row>
          <View style={[styles.row, styles.actions]}>
            <ConfirmButton styles={styles} label="Remove" confirmLabel="Confirm remove" onConfirm={() => void drop(key)} />
          </View>
        </Card>
      ))}
    </Section>
  );
}

function SandboxCard({ styles, sandbox }: { styles: Styles; sandbox: SandboxSummary }) {
  const action = useSandboxAction();
  const abrupt = action.data?.graceful === false;
  return (
    <Card styles={styles}>
      <Row styles={styles} label={sandbox.name} first>
        {sandbox.kind === "template-prep" ? `${sandbox.status} · template preparation` : sandbox.status}
      </Row>
      {sandbox.template ? (
        <Row styles={styles} label="Template">
          <Text style={styles.mono}>{shortRef(sandbox.template)}</Text>
        </Row>
      ) : null}
      {sandbox.memory ? (
        <Row styles={styles} label="Memory">
          {sandbox.memory}
        </Row>
      ) : null}
      <Row styles={styles} label="Workspace">
        <Text style={styles.mono}>{sandbox.workspaces[0] ?? "-"}</Text>
      </Row>
      <View style={[styles.row, styles.actions, { justifyContent: "flex-start" }]}>
        <Button
          styles={styles}
          label="Stop"
          disabled={action.isPending || sandbox.status !== "running"}
          onPress={() => action.mutate({ name: sandbox.name, action: "stop" })}
        />
        <ConfirmButton
          styles={styles}
          label="Remove"
          confirmLabel="Confirm remove"
          disabled={action.isPending}
          onConfirm={() => action.mutate({ name: sandbox.name, action: "remove" })}
        />
      </View>
      {abrupt ? (
        <Text style={[styles.muted, { padding: 12 }]}>Stopped without shutting its Docker down first: databases recover on the next start.</Text>
      ) : null}
      {action.error ? <Text style={[styles.error, { padding: 12 }]}>{errorMessage(action.error)}</Text> : null}
    </Card>
  );
}
