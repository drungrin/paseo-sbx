import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { shellCommandRpc, shellResultSchema } from "../shared/rpc";
import { agentState, agentTone, errorMessage, formatMiB, operationLabel, plural, sandboxStatus, shortRef } from "./format";
import { DownloadConsentPrompt, useDownloadConsent } from "./consent";
import { Column, Columns, Empty, Frame, Needs, StatusChip, Tabbed, type Tab } from "./frame";
import {
  Actions,
  Button,
  ConfirmButton,
  Dot,
  FadeIn,
  ListRow,
  Meter,
  Note,
  Pill,
  Pulse,
  Section,
  figures,
  kicker,
  mono,
  text,
  tint,
  toneColor,
} from "./kit";
import { panelBadges, panelNeeds, type PanelTab, type PanelTabProps } from "./panel";
import { MountsTab, ResourcesTab, VariablesTab } from "./panel-config";
import { ServicesTab } from "./panel-services";
import { TemplateTab } from "./panel-template";
import {
  useArchiveAgent,
  useAwaitOperation,
  useInvalidateAll,
  useOpenTerminal,
  useSandboxAction,
  useSandboxDescription,
  useStatus,
  type Description,
} from "./queries";

const TAB_LABELS: Record<PanelTab, string> = {
  overview: "Overview",
  services: "Services",
  template: "Template",
  resources: "Resources",
  mounts: "Mounts",
  variables: "Variables",
};

export function WorkspacePanel({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const description = useSandboxDescription(workspaceId, directory);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ workspaceId: string; tab: PanelTab }>({ workspaceId, tab: "overview" });
  const compact = layout.compact || (panelWidth !== null && panelWidth < 720);
  const tab = selection.workspaceId === workspaceId ? selection.tab : "overview";
  const go = (next: PanelTab) => setSelection({ workspaceId, tab: next });
  const data = description.data;

  const refresh = (
    <Button
      theme={theme}
      label={description.isFetching ? "Refreshing" : "Refresh"}
      busy={description.isFetching}
      small
      onPress={() => void description.refetch()}
    />
  );
  let body;
  if (directory === null) {
    body = (
      <Frame theme={theme} compact={compact} title="Sandbox">
        <Empty theme={theme} title="Workspace not found" detail="This workspace is no longer known to the daemon." />
      </Frame>
    );
  } else if (!data) {
    body = (
      <Frame theme={theme} compact={compact} title="Sandbox" actions={refresh}>
        {description.error ? (
          <Section theme={theme} tone="danger" overline="Could not read the sandbox">
            <Text style={text(theme, 13)}>{errorMessage(description.error)}</Text>
          </Section>
        ) : (
          <Text accessibilityLiveRegion="polite" style={text(theme, 13, "400", true)}>
            Reading the sandbox…
          </Text>
        )}
      </Frame>
    );
  } else {
    const badges = panelBadges(data);
    const tabs: Tab<PanelTab>[] = (Object.keys(TAB_LABELS) as PanelTab[]).map((id) => ({
      id,
      label: TAB_LABELS[id],
      badge: badges[id],
    }));
    const props: PanelTabProps = {
      data,
      workspaceId,
      directory,
      theme,
      compact,
      header: { status: <SandboxChip data={data} theme={theme} />, actions: refresh },
      go,
    };
    body = (
      <Tabbed
        // Keyed so another workspace starts with fresh tabs and drafts.
        key={workspaceId}
        theme={theme}
        compact={compact}
        label="Sandbox sections"
        tabs={tabs}
        active={tab}
        onSelect={go}
        renderTab={(id) => {
          if (id === "overview") return <OverviewTab {...props} openAgent={navigation?.openAgent} />;
          if (id === "services") return <ServicesTab {...props} />;
          if (id === "template") return <TemplateTab {...props} />;
          if (id === "resources") return <ResourcesTab {...props} />;
          if (id === "mounts") return <MountsTab {...props} />;
          return <VariablesTab {...props} />;
        }}
      />
    );
  }
  return (
    <View
      onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}
    >
      {body}
    </View>
  );
}

/** The sandbox's status; an operation running on it takes its place. */
function SandboxChip({ data, theme }: { data: Description; theme: PanelTabProps["theme"] }) {
  const running = data.operations.find((operation) => operation.status === "running");
  if (running) return <StatusChip theme={theme} tone="accent" moving label={`${operationLabel(running.kind)} in progress`} />;
  const status = sandboxStatus(data.status);
  return <StatusChip theme={theme} tone={status.tone} moving={status.moving} label={status.label} />;
}

function OverviewTab(props: PanelTabProps & { openAgent?: (input: { agentId: string }) => void }) {
  const { data, theme, compact, header, go, openAgent } = props;
  const needs = panelNeeds(data).map((need) => ({
    ...need,
    action: need.tab ? { label: "Open", onPress: () => go(need.tab ?? "overview") } : null,
  }));
  return (
    <Frame
      theme={theme}
      compact={compact}
      title="Overview"
      description="This workspace's microVM: what runs in it, and what needs you."
      {...header}
      notes={[
        "One sandbox serves every agent of this workspace's directory. Agents created with a sandbox provider run in it; other agents stay on the host.",
        "Template, mounts, memory and CPUs are fixed when a sandbox is created: Recreate applies a change, and keeps transcripts and the workspace files.",
        "The VM stops on its own once no agent or shell holds it. Idle agents hold it until you archive them.",
      ]}
    >
      <FadeIn>
        <Hero {...props} />
      </FadeIn>
      <FadeIn delay={80}>
        <Needs
          theme={theme}
          needs={needs}
          calm={{
            title: "Nothing needs you",
            detail: data.status
              ? "The sandbox matches the repository's settings."
              : "The sandbox is created the first time an agent or shell needs it.",
          }}
        />
      </FadeIn>
      <FadeIn delay={140}>
        <Columns compact={compact}>
          <Column compact={compact}>
            <AgentsCard data={data} theme={theme} compact={compact} openAgent={openAgent} />
          </Column>
          <Column compact={compact}>
            <Section theme={theme} overline="Paths" title="Where it lives" gap={6}>
              <ListRow
                theme={theme}
                first
                monospace
                title={data.workspace}
                detail="Workspace, mounted writable at the same path"
              />
              <ListRow theme={theme} monospace title={data.name} detail="Sandbox name in sbx" />
              {data.siblings.map((name) => (
                <ListRow key={name} theme={theme} monospace title={name} detail="Another sandbox of this repository" />
              ))}
            </Section>
          </Column>
        </Columns>
      </FadeIn>
    </Frame>
  );
}

function HeroFigure({
  label,
  value,
  detail,
  theme,
  tone,
  children,
}: {
  label: string;
  value: string;
  detail?: string | null;
  theme: PanelTabProps["theme"];
  tone?: "warning";
  children?: ReactNode;
}) {
  return (
    <View style={{ flexBasis: 150, flexGrow: 1, minWidth: 0, gap: 3 }}>
      <Text style={kicker(theme)}>{label}</Text>
      <Text
        numberOfLines={1}
        style={{ ...text(theme, 20, "700"), ...figures, ...(tone ? { color: toneColor(theme, tone) } : {}) }}
      >
        {value}
      </Text>
      {detail ? <Text style={{ ...text(theme, 12, "400", true), ...figures }}>{detail}</Text> : null}
      {children}
    </View>
  );
}

function Hero({ data, theme, compact, workspaceId, directory }: PanelTabProps) {
  const status = useStatus();
  const action = useSandboxAction();
  const invalidate = useInvalidateAll();
  const openTerminal = useOpenTerminal(workspaceId);
  const getShell = useRpc(shellCommandRpc);
  const awaitOperation = useAwaitOperation();
  const openShell = useMutation({
    mutationFn: async () =>
      openTerminal(shellResultSchema.parse(await awaitOperation(await getShell({ workspaceId, directory })))),
    onSettled: invalidate,
  });
  const consent = useDownloadConsent();
  const accent = toneColor(theme, "accent");
  const created = data.status !== null;
  // Without a template the sandbox is created from sbx's kit image, which can be downloaded.
  const fromImage = data.template.configured === null;
  const hostCpus = status.data?.hostCpus ?? null;
  const cpus = data.cpus === 0 ? (hostCpus === null ? "All" : String(hostCpus)) : String(data.cpus);
  const working = data.agents.filter((agent) => agent.activeTurn).length;
  const memoryShare = data.rssMiB === null ? null : Math.round((100 * data.rssMiB) / data.memoryMiB);
  const running = data.operations.find((operation) => operation.status === "running");
  const busy = openShell.isPending || action.isPending;
  return (
    <View
      style={{
        borderRadius: 20,
        padding: compact ? 18 : 24,
        gap: 18,
        overflow: "hidden",
        backgroundColor: tint(theme, accent, 0.1),
      }}
    >
      <View
        style={{
          position: "absolute",
          right: -120,
          top: -160,
          width: 420,
          height: 420,
          borderRadius: 210,
          backgroundColor: tint(theme, accent, 0.05),
        }}
      />
      <View
        style={{
          position: "absolute",
          right: -40,
          top: -90,
          width: 220,
          height: 220,
          borderRadius: 110,
          backgroundColor: tint(theme, accent, 0.05),
        }}
      />
      <View
        style={{
          flexDirection: compact ? "column" : "row",
          justifyContent: "space-between",
          alignItems: compact ? "flex-start" : "center",
          gap: 10,
        }}
      >
        <Text style={{ ...kicker(theme), color: accent }}>
          {[
            "Docker Sandboxes microVM",
            data.template.sandbox || data.template.configured
              ? shortRef(data.template.sandbox ?? data.template.configured ?? "")
              : "sbx image",
          ].join("  ·  ")}
        </Text>
        {data.agents.length > 0 ? (
          <Pill
            theme={theme}
            tone={working > 0 ? "accent" : "neutral"}
            dot
            moving={working > 0}
            label={working > 0 ? `${plural(working, "agent")} working` : `${plural(data.agents.length, "agent")} idle`}
          />
        ) : null}
      </View>
      <View style={{ gap: 4 }}>
        <Text role="heading" style={{ ...text(theme, compact ? 24 : 28, "700"), letterSpacing: -0.5 }}>
          {data.repoName}
        </Text>
        <Text selectable style={mono(theme, 12, true)}>
          {data.name}
        </Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: compact ? 14 : 24 }}>
        <HeroFigure
          theme={theme}
          label="Memory"
          value={data.rssMiB === null ? formatMiB(data.memoryMiB) : formatMiB(data.rssMiB)}
          detail={
            data.rssMiB === null
              ? created
                ? "Limit · the VM is stopped"
                : "Limit for the new sandbox"
              : `of ${formatMiB(data.memoryMiB)} · ${memoryShare}%`
          }
        >
          {data.rssMiB === null ? null : (
            <View style={{ marginTop: 4 }}>
              <Meter
                theme={theme}
                value={data.rssMiB}
                max={data.memoryMiB}
                color={memoryShare !== null && memoryShare >= 90 ? toneColor(theme, "warning") : accent}
              />
            </View>
          )}
        </HeroFigure>
        <HeroFigure theme={theme} label="CPUs" value={cpus} detail={hostCpus === null ? null : `of ${hostCpus} on this host`} />
        <HeroFigure
          theme={theme}
          label="Template"
          value={
            data.template.sandbox
              ? shortRef(data.template.sandbox)
              : created
                ? "sbx image"
                : shortRef(data.template.configured ?? "sbx image")
          }
          tone={data.template.status === "diverged" ? "warning" : undefined}
          detail={
            data.template.status === "diverged"
              ? "The repository now uses another"
              : data.template.status === "unknown"
                ? "Not recorded at creation"
                : created
                  ? "Matches the repository"
                  : "For the new sandbox"
          }
        />
      </View>
      <Actions>
        <Button
          theme={theme}
          kind="primary"
          label={created ? "Open shell" : "Create and open shell"}
          busy={openShell.isPending}
          disabled={busy}
          onPress={() => consent.request(() => openShell.mutate(), !created && fromImage)}
        />
        {created ? (
          <>
            <Button
              theme={theme}
              label="Stop"
              disabled={busy || data.status !== "running"}
              onPress={() => action.mutate({ name: data.name, action: "stop" })}
            />
            <ConfirmButton
              theme={theme}
              label="Recreate"
              confirmLabel="Confirm recreate"
              disabled={busy || data.recreateBlockers.length > 0}
              onConfirm={() => consent.request(() => action.mutate({ name: data.name, action: "recreate" }), fromImage)}
            />
            <ConfirmButton
              theme={theme}
              label="Remove"
              confirmLabel="Confirm remove"
              disabled={busy}
              onConfirm={() => action.mutate({ name: data.name, action: "remove" })}
            />
          </>
        ) : null}
      </Actions>
      <DownloadConsentPrompt consent={consent} theme={theme} />
      {running ? (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
          <Pulse color={accent} size={6} />
          <Text style={text(theme, 13, "500")}>{`${operationLabel(running.kind)} of ${running.target} in progress…`}</Text>
        </View>
      ) : null}
      {created && data.recreateBlockers.length > 0 ? (
        <Note theme={theme}>{`Recreate needs every agent of this sandbox archived: ${data.recreateBlockers.join("; ")}.`}</Note>
      ) : null}
      {action.data?.graceful === false ? (
        <Note theme={theme}>Stopped without shutting its Docker down first: databases recover on the next start.</Note>
      ) : null}
      {openShell.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(openShell.error)}
        </Note>
      ) : null}
      {action.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(action.error)}
        </Note>
      ) : null}
    </View>
  );
}

function AgentsCard({
  data,
  theme,
  compact,
  openAgent,
}: {
  data: Description;
  theme: PanelTabProps["theme"];
  compact: boolean;
  openAgent?: (input: { agentId: string }) => void;
}) {
  const archive = useArchiveAgent();
  return (
    <Section theme={theme} overline={plural(data.agents.length, "agent")} title="Agents in this sandbox" gap={6}>
      {data.agents.length === 0 ? (
        <Note theme={theme}>No agent runs here. Create one with a sandbox provider from the + menu.</Note>
      ) : (
        <View role="list">
          {data.agents.map((agent, index) => (
            <ListRow
              key={agent.id}
              theme={theme}
              first={index === 0}
              stacked={compact}
              lead={<Dot color={toneColor(theme, agentTone(agent))} moving={agent.activeTurn} />}
              title={agent.title ?? agent.id}
              detail={agentState(agent)}
              aside={
                <>
                  {openAgent ? (
                    <Button theme={theme} small kind="quiet" label="Open" onPress={() => openAgent({ agentId: agent.id })} />
                  ) : null}
                  {agent.archived ? null : (
                    <ConfirmButton
                      theme={theme}
                      small
                      label="Archive"
                      confirmLabel="Confirm archive"
                      disabled={archive.isPending}
                      onConfirm={() => archive.mutate(agent.id)}
                    />
                  )}
                </>
              }
            />
          ))}
        </View>
      )}
      <Note theme={theme}>Idle agents keep the VM running. Archiving the last one lets it stop on its own.</Note>
      {archive.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(archive.error)}
        </Note>
      ) : null}
    </Section>
  );
}
