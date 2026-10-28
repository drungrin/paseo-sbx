import { DownloadConsentPrompt, useDownloadConsent } from "./consent";
import { useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import type { AgentStatus, SandboxSummary, TemplateSummary } from "../shared/rpc";
import { sandboxSettings } from "../shared/settings";
import {
  agentState,
  agentTone,
  baseName,
  errorMessage,
  formatBytes,
  formatMiB,
  parseMemoryFlag,
  plural,
  repoPath,
  sandboxStatus,
  shortRef,
} from "./format";
import { Column, Columns, Empty, Figures, Frame, Needs, StatusChip, Tabbed, type Need, type Tab } from "./frame";
import {
  Actions,
  Button,
  Code,
  ConfirmButton,
  Dot,
  FadeIn,
  Legend,
  ListRow,
  Meter,
  Note,
  Pill,
  Section,
  SegmentBar,
  Stat,
  figures,
  kicker,
  mono,
  text,
  tint,
  toneColor,
  type Theme,
  type Tone,
} from "./kit";
import { McpServersTab } from "./mcp";
import {
  useArchiveAgent,
  useConfigureAgent,
  useInvalidateAll,
  useMcpServers,
  useMemory,
  useRemoveTemplate,
  useSandboxAction,
  useSandboxes,
  useStatus,
  useTemplates,
} from "./queries";

interface SandboxesScreenProps extends PluginScreenProps {
  openSettings(): void;
}

type ScreenTab = "overview" | "sandboxes" | "agents" | "templates" | "mcp";
type Status = NonNullable<ReturnType<typeof useStatus>["data"]>;
type Memory = NonNullable<ReturnType<typeof useMemory>["data"]>;
type McpServers = NonNullable<ReturnType<typeof useMcpServers>["data"]>;

/** Ready to run sessions: provider registered and current, catalog sandbox created and answering. */
const agentReady = (agent: AgentStatus) => agent.provider.current && agent.catalog.exists && agent.catalog.cliVersion !== null;

function agentView(agent: AgentStatus): { label: string; tone: Tone } {
  if (!agent.enabled) return { label: "Off", tone: "neutral" };
  if (agentReady(agent)) return { label: "Ready", tone: "success" };
  if (agent.provider.configured && !agent.provider.current) return { label: "Outdated", tone: "warning" };
  return { label: "Needs setup", tone: "warning" };
}

export function SandboxesScreen({ theme, layout, openSettings }: SandboxesScreenProps) {
  const status = useStatus();
  const sandboxes = useSandboxes();
  const memory = useMemory();
  const templates = useTemplates();
  const mcp = useMcpServers();
  const settings = useSettings(sandboxSettings);
  const [tab, setTab] = useState<ScreenTab>("overview");
  const [width, setWidth] = useState<number | null>(null);
  const compact = layout.compact || (width !== null && width < 760);

  const fetching = status.isFetching || sandboxes.isFetching || memory.isFetching;
  const header = {
    status: <SbxChip status={status.data} error={status.error} theme={theme} />,
    actions: (
      <>
        <Button
          theme={theme}
          small
          label={fetching ? "Refreshing" : "Refresh"}
          busy={fetching}
          onPress={() =>
            void Promise.all([status.refetch(), sandboxes.refetch(), memory.refetch(), templates.refetch(), mcp.refetch()])
          }
        />
        <Button theme={theme} small label="Settings" onPress={openSettings} />
      </>
    ),
  };
  const working = sandboxes.data?.sandboxes.filter((sandbox) => sandbox.kind === "working") ?? [];
  const custom = (templates.data?.templates ?? []).filter((template) => !template.base);
  const agentsNeedingSetup = status.data?.agents.filter((agent) => agent.enabled && !agentReady(agent)).length ?? 0;
  const legacy = settings.status === "ready" ? Object.keys(settings.values.legacyOverrides).length : 0;
  const needs = screenNeeds(status.data, memory.data, mcp.data, legacy, setTab);
  const mcpWaiting = mcp.data?.servers.filter((server) => server.status !== "ready").length ?? 0;
  const tabs: Tab<ScreenTab>[] = [
    {
      id: "overview",
      label: "Overview",
      badge:
        needs.length > 0
          ? { label: String(needs.length), tone: needs.some((need) => need.tone === "danger") ? "danger" : "warning" }
          : null,
    },
    {
      id: "sandboxes",
      label: "Sandboxes",
      badge: sandboxes.data
        ? { label: `${working.filter((sandbox) => sandbox.status === "running").length}/${working.length}` }
        : null,
    },
    {
      id: "agents",
      label: "Agents",
      badge: agentsNeedingSetup > 0 ? { label: String(agentsNeedingSetup), tone: "warning" } : null,
    },
    { id: "templates", label: "Templates", badge: templates.data ? { label: String(custom.length) } : null },
    {
      id: "mcp",
      label: "MCP servers",
      badge:
        mcpWaiting > 0 || mcp.data?.unrecognized
          ? { label: String(mcpWaiting || 1), tone: "warning" }
          : mcp.data
            ? { label: String(mcp.data.servers.length) }
            : null,
    },
  ];

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}
    >
      <Tabbed<ScreenTab>
        theme={theme}
        compact={compact}
        label="Sandboxes sections"
        tabs={tabs}
        active={tab}
        onSelect={setTab}
        renderTab={(id) => {
          if (id === "overview") {
            return (
              <Frame
                theme={theme}
                compact={compact}
                title="Docker Sandboxes"
                description="Each workspace's agents run in their own microVM. What they hold, and what needs you."
                {...header}
                notes={[
                  "VM memory is each VM's resident memory: an estimate, where pages shared between VMs count once per VM.",
                  "Memory pressure is the host's PSI over the last minute: the share of time tasks waited on memory. The alert thresholds are in the plugin settings.",
                  "A VM stops on its own once no agent or shell holds it. Idle agents hold it until you archive them.",
                ]}
              >
                {status.error ? (
                  <Section theme={theme} tone="danger" overline="Could not reach the plugin">
                    <Text style={text(theme, 13)}>{errorMessage(status.error)}</Text>
                  </Section>
                ) : null}
                {memory.data ? (
                  <FadeIn>
                    <MemoryHero memory={memory.data} status={status.data} theme={theme} compact={compact} />
                  </FadeIn>
                ) : (
                  <Text accessibilityLiveRegion="polite" style={text(theme, 13, "400", true)}>
                    Reading the host's memory…
                  </Text>
                )}
                <FadeIn delay={80}>
                  <Needs
                    theme={theme}
                    needs={needs}
                    calm={{
                      title: "Nothing needs you",
                      detail: "The host has memory to spare and every enabled agent is set up.",
                    }}
                  />
                </FadeIn>
                {memory.data ? (
                  <FadeIn delay={140}>
                    <Holders memory={memory.data} theme={theme} compact={compact} />
                  </FadeIn>
                ) : null}
                {legacy > 0 ? <LegacyOverrides theme={theme} /> : null}
              </Frame>
            );
          }
          if (id === "sandboxes") {
            return (
              <Frame
                theme={theme}
                compact={compact}
                title="Sandboxes"
                description="Every VM the plugin created: the workspaces', template preparations and agent catalogs."
                {...header}
                notes={[
                  "Stop shuts a VM down; the next agent or shell starts it again. Remove deletes it with everything inside: the workspace files and transcripts stay on the host.",
                  "Agent catalogs answer Paseo's version and model queries for each sandbox provider. Removing one makes it come back at the next query.",
                ]}
              >
                <SandboxList
                  sandboxes={sandboxes.data?.sandboxes ?? null}
                  error={sandboxes.error}
                  memory={memory.data}
                  theme={theme}
                  compact={compact}
                />
              </Frame>
            );
          }
          if (id === "mcp") {
            return <McpServersTab theme={theme} compact={compact} header={header} stateHome={status.data?.stateHome ?? null} />;
          }
          if (id === "agents") {
            return (
              <Frame
                theme={theme}
                compact={compact}
                title="Agents"
                description="The sandbox providers: Paseo's Claude and Codex, running in each workspace's VM."
                {...header}
                notes={[
                  "Sessions run the CLI of the workspace's template. Each agent's catalog sandbox answers Paseo's version and model queries; Update recreates it from sbx's latest kit.",
                  "Agents sign in through sbx's secrets, which its proxy adds to their requests: the token never enters the VM.",
                  "Turn agents on or off in the plugin settings. Turning one off keeps the agents created with it.",
                ]}
              >
                {status.data ? <AgentList status={status.data} theme={theme} compact={compact} /> : null}
              </Frame>
            );
          }
          return (
            <Frame
              theme={theme}
              compact={compact}
              title="Templates"
              description="Saved VM filesystems new sandboxes start from."
              {...header}
              notes={[
                "Prepare a template from a workspace's Sandbox panel: it opens a shell in a clean sandbox, then saves it.",
                "Remove appears on templates nothing uses. One the default or a repository picks needs another picked first; one a sandbox was created from needs that sandbox recreated or removed.",
              ]}
            >
              <TemplateList
                templates={custom}
                loaded={templates.data !== undefined}
                error={templates.error}
                theme={theme}
                compact={compact}
              />
            </Frame>
          );
        }}
      />
    </View>
  );
}

function SbxChip({ status, error, theme }: { status: Status | undefined; error: unknown; theme: Theme }) {
  if (error) return <StatusChip theme={theme} tone="danger" label="Plugin unreachable" />;
  if (!status) return <StatusChip theme={theme} tone="neutral" label="Checking sbx" />;
  if (!status.sbx.installed) return <StatusChip theme={theme} tone="danger" label="sbx not installed" />;
  const version = status.sbx.version ? `sbx ${status.sbx.version}` : "sbx";
  if (status.sbx.daemon === "running") return <StatusChip theme={theme} tone="success" moving label={`${version} · running`} />;
  return <StatusChip theme={theme} tone="warning" label={`${version} · daemon ${status.sbx.daemon}`} />;
}

function screenNeeds(
  status: Status | undefined,
  memory: Memory | undefined,
  mcp: McpServers | undefined,
  legacy: number,
  go: (tab: ScreenTab) => void,
): Need[] {
  const needs: Need[] = [];
  if (status?.sbx.error) needs.push({ tone: "danger", title: "sbx reported an error", detail: status.sbx.error });
  else if (status && !status.sbx.installed)
    needs.push({
      tone: "danger",
      title: "sbx is not installed",
      detail: "Install Docker Sandboxes on this host to run sandboxed agents.",
    });
  for (const alert of memory?.alerts ?? []) {
    needs.push({ tone: "danger", title: `Memory alert: ${alert}`, detail: "Archive idle agents below to let their VMs stop." });
  }
  for (const agent of status?.agents ?? []) {
    if (!agent.enabled) continue;
    const view = agentView(agent);
    if (view.label !== "Ready") {
      needs.push({
        tone: "warning",
        title: `${agent.label} ${view.label === "Outdated" ? "points at an older launcher" : "is not set up"}`,
        detail: "Configure registers its provider and creates its catalog sandbox.",
        action: { label: "Agents", onPress: () => go("agents") },
      });
    } else if (agent.id !== "claude" && !agent.login.stored) {
      needs.push({
        tone: "warning",
        title: `${agent.label} has no login`,
        detail: `Store the sbx ${agent.login.service} secret, then press Update.`,
        action: { label: "Agents", onPress: () => go("agents") },
      });
    }
  }
  for (const server of mcp?.servers ?? []) {
    if (server.status === "needs-auth") {
      needs.push({
        tone: "warning",
        title: `${server.name} needs a sign-in`,
        detail: "Until then agents see only its sign-in tool.",
        action: { label: "MCP servers", onPress: () => go("mcp") },
      });
    } else if (server.status === "needs-secret") {
      needs.push({
        tone: "warning",
        title: `${server.name} has no API key stored`,
        detail: "Its card in MCP servers shows the command that stores it.",
        action: { label: "MCP servers", onPress: () => go("mcp") },
      });
    }
  }
  if (mcp?.unrecognized) {
    needs.push({
      tone: "warning",
      title: "sbx changed how it reports MCP servers",
      detail: "MCP servers says what this means and how to report it.",
      action: { label: "MCP servers", onPress: () => go("mcp") },
    });
  }
  if (legacy > 0) {
    needs.push({
      tone: "warning",
      title: `${plural(legacy, "setting")} from an older version to reassign`,
      detail: "Set them again in the repository's Sandbox panel, then remove them below.",
    });
  }
  return needs;
}

function MemoryHero({
  memory,
  status,
  theme,
  compact,
}: {
  memory: Memory;
  status: Status | undefined;
  theme: Theme;
  compact: boolean;
}) {
  const running = memory.sandboxes.filter((sandbox) => sandbox.rssMiB !== null).length;
  const accent = toneColor(theme, "accent");
  const host = memory.host;
  const alert = memory.alerts.length > 0;
  const tone = alert ? toneColor(theme, "danger") : accent;
  const otherUsed = host ? Math.max(0, host.totalMiB - host.availableMiB - memory.vmRssMiB) : 0;
  const muted = tint(theme, theme.colors.foregroundMuted, 0.55);
  const free = tint(theme, theme.colors.foregroundMuted, 0.2);
  return (
    <View
      style={{
        borderRadius: 20,
        padding: compact ? 18 : 24,
        gap: 18,
        overflow: "hidden",
        backgroundColor: tint(theme, tone, 0.1),
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
          backgroundColor: tint(theme, tone, 0.05),
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
          backgroundColor: tint(theme, tone, 0.05),
        }}
      />
      <Text style={{ ...kicker(theme), color: tone }}>
        {[
          "Host memory",
          status ? `${status.hostCpus} CPUs` : null,
          status ? `${formatMiB(status.defaultMemoryMiB)} per sandbox by default` : null,
        ]
          .filter(Boolean)
          .join("  ·  ")}
      </Text>
      <View
        style={{ flexDirection: compact ? "column" : "row", gap: compact ? 12 : 28, alignItems: compact ? "stretch" : "center" }}
      >
        <View style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text style={{ ...text(theme, 40, "700"), ...figures, letterSpacing: -1, lineHeight: 46 }}>
              {formatMiB(memory.vmRssMiB)}
            </Text>
            <Text style={text(theme, 13, "400", true)}>{`in ${plural(running, "running VM")}`}</Text>
          </View>
          {host ? (
            <Text style={{ ...text(theme, 13, "400", true), ...figures }}>{`of ${formatMiB(host.totalMiB)} on this host`}</Text>
          ) : null}
        </View>
        {host ? (
          <View style={{ flex: 1, gap: 10, minWidth: 0 }}>
            <SegmentBar
              theme={theme}
              height={12}
              label={`VMs ${formatMiB(memory.vmRssMiB)}, other use ${formatMiB(otherUsed)}, available ${formatMiB(host.availableMiB)}`}
              segments={[
                { value: memory.vmRssMiB, color: tone, label: "VMs" },
                { value: otherUsed, color: muted, label: "Other" },
                { value: host.availableMiB, color: free, label: "Available" },
              ]}
            />
            <Legend
              theme={theme}
              items={[
                { color: tone, label: `${formatMiB(memory.vmRssMiB)} sandbox VMs` },
                { color: muted, label: `${formatMiB(otherUsed)} everything else` },
                { color: free, label: `${formatMiB(host.availableMiB)} available` },
              ]}
            />
          </View>
        ) : null}
      </View>
      {host ? (
        <Figures>
          <Stat
            theme={theme}
            label="Available"
            value={`${Math.round((100 * host.availableMiB) / host.totalMiB)}%`}
            detail={formatMiB(host.availableMiB)}
            tone={alert ? "danger" : undefined}
            size={20}
          />
          <Stat
            theme={theme}
            label="Swap in use"
            value={formatMiB(host.swapUsedMiB)}
            tone={host.swapUsedMiB > 1024 ? "warning" : undefined}
            size={20}
          />
          <Stat
            theme={theme}
            label="Pressure · 60 s"
            value={host.psiSome60 === null ? "—" : `${host.psiSome60.toFixed(1)}%`}
            detail={host.psiSome60 === null ? "Unavailable on this host" : "Time spent waiting on memory"}
            tone={alert ? "danger" : undefined}
            size={20}
          />
        </Figures>
      ) : null}
    </View>
  );
}

/** The VMs holding memory, biggest first, with the agents that keep each one running. */
function Holders({ memory, theme, compact }: { memory: Memory; theme: Theme; compact: boolean }) {
  const archive = useArchiveAgent();
  const shown = [...memory.sandboxes]
    .filter((sandbox) => sandbox.rssMiB !== null || sandbox.activeAgents.length > 0)
    .sort((a, b) => (b.rssMiB ?? 0) - (a.rssMiB ?? 0));
  const max = Math.max(1, ...shown.map((sandbox) => sandbox.rssMiB ?? 0));
  return (
    <Section theme={theme} overline="Biggest first" title="What keeps VMs running" gap={4}>
      {shown.length === 0 ? (
        <Note theme={theme}>No VM is running.</Note>
      ) : (
        <View role="list">
          {shown.map((sandbox, index) => (
            <View
              key={sandbox.name}
              role="listitem"
              style={{ gap: 8, paddingVertical: 12, borderTopWidth: index === 0 ? 0 : 1, borderColor: theme.colors.border }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
                <Text numberOfLines={1} selectable style={{ ...mono(theme, 13), flex: 1 }}>
                  {sandbox.name}
                </Text>
                <Text style={{ ...text(theme, 13, "600"), ...figures }}>
                  {sandbox.rssMiB === null ? "—" : formatMiB(sandbox.rssMiB)}
                </Text>
              </View>
              <Meter theme={theme} value={sandbox.rssMiB ?? 0} max={max} color={toneColor(theme, "accent")} />
              {sandbox.activeAgents.length === 0 ? (
                <Note theme={theme}>No agent holds it: it stops once its shells close.</Note>
              ) : (
                sandbox.activeAgents.map((agent) => (
                  <View
                    key={agent.id}
                    style={{
                      flexDirection: compact ? "column" : "row",
                      alignItems: compact ? "flex-start" : "center",
                      gap: 8,
                      paddingLeft: 4,
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: compact ? 0 : 1, minWidth: 0 }}>
                      <View style={{ width: 18, alignItems: "center" }}>
                        <Dot color={toneColor(theme, agentTone(agent))} moving={agent.activeTurn} size={7} />
                      </View>
                      <Text numberOfLines={1} style={text(theme, 13, "500")}>
                        {agent.title ?? agent.id}
                      </Text>
                      <Text style={text(theme, 12, "400", true)}>{agentState(agent)}</Text>
                    </View>
                    {agent.activeTurn ? null : (
                      <ConfirmButton
                        theme={theme}
                        small
                        label="Archive"
                        confirmLabel="Confirm archive"
                        disabled={archive.isPending}
                        onConfirm={() => archive.mutate(agent.id)}
                      />
                    )}
                  </View>
                ))
              )}
            </View>
          ))}
        </View>
      )}
      {archive.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(archive.error)}
        </Note>
      ) : null}
    </Section>
  );
}

const KIND_GROUPS: { kind: SandboxSummary["kind"]; title: string; overline: string }[] = [
  { kind: "working", title: "Workspaces", overline: "Where agents run" },
  { kind: "template-prep", title: "Template preparations", overline: "Started from a workspace's Template tab" },
  { kind: "catalog", title: "Agent catalogs", overline: "Answer Paseo's version and model queries" },
];

function SandboxList({
  sandboxes,
  error,
  memory,
  theme,
  compact,
}: {
  sandboxes: SandboxSummary[] | null;
  error: unknown;
  memory: Memory | undefined;
  theme: Theme;
  compact: boolean;
}) {
  if (error)
    return (
      <Note theme={theme} tone="danger">
        {errorMessage(error)}
      </Note>
    );
  if (!sandboxes) return <Text style={text(theme, 13, "400", true)}>Listing sandboxes…</Text>;
  if (sandboxes.length === 0) {
    return (
      <Empty
        theme={theme}
        title="No sandboxes yet"
        detail="One is created the first time a sandboxed agent starts in a workspace."
      />
    );
  }
  const rss = new Map(memory?.sandboxes.map((sandbox) => [sandbox.name, sandbox.rssMiB]) ?? []);
  return (
    <>
      {KIND_GROUPS.map((group) => {
        const entries = sandboxes.filter((sandbox) => sandbox.kind === group.kind);
        if (entries.length === 0) return null;
        return (
          <Section key={group.kind} theme={theme} overline={`${group.overline} · ${entries.length}`} title={group.title} gap={4}>
            <View role="list">
              {entries.map((sandbox, index) => (
                <SandboxRow
                  key={sandbox.name}
                  sandbox={sandbox}
                  rssMiB={rss.get(sandbox.name) ?? null}
                  first={index === 0}
                  theme={theme}
                  compact={compact}
                />
              ))}
            </View>
          </Section>
        );
      })}
    </>
  );
}

function SandboxRow({
  sandbox,
  rssMiB,
  first,
  theme,
  compact,
}: {
  sandbox: SandboxSummary;
  rssMiB: number | null;
  first: boolean;
  theme: Theme;
  compact: boolean;
}) {
  const action = useSandboxAction();
  const status = sandboxStatus(sandbox.status);
  const limit = parseMemoryFlag(sandbox.memory);
  const place = sandbox.workspaces[0] ?? (sandbox.repoKey ? repoPath(sandbox.repoKey) : null);
  const facts = [
    place ? baseName(place) : null,
    sandbox.template ? shortRef(sandbox.template) : sandbox.kind === "catalog" ? "sbx kit" : "sbx image",
    rssMiB !== null && limit !== null
      ? `${formatMiB(rssMiB)} of ${formatMiB(limit)}`
      : limit !== null
        ? `${formatMiB(limit)} limit`
        : null,
  ].filter(Boolean);
  return (
    <View
      role="listitem"
      style={{ gap: 8, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderColor: theme.colors.border }}
    >
      <View
        style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: compact ? 8 : 12 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: compact ? 0 : 1, minWidth: 0 }}>
          <View style={{ width: 22, alignItems: "center" }}>
            <Dot color={toneColor(theme, status.tone)} moving={status.moving} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text numberOfLines={1} selectable style={mono(theme, 13)}>
              {sandbox.name}
            </Text>
            <Text numberOfLines={1} style={text(theme, 12, "400", true)}>
              {[status.label, ...facts].join("  ·  ")}
            </Text>
          </View>
        </View>
        <Actions>
          <Button
            theme={theme}
            small
            label="Stop"
            disabled={action.isPending || sandbox.status !== "running"}
            onPress={() => action.mutate({ name: sandbox.name, action: "stop" })}
          />
          <ConfirmButton
            theme={theme}
            small
            label="Remove"
            confirmLabel="Confirm remove"
            busy={action.isPending && action.variables?.action === "remove"}
            disabled={action.isPending}
            onConfirm={() => action.mutate({ name: sandbox.name, action: "remove" })}
          />
        </Actions>
      </View>
      {rssMiB !== null && limit !== null ? (
        <Meter theme={theme} value={rssMiB} max={limit} color={toneColor(theme, "accent")} height={4} />
      ) : null}
      {action.data?.graceful === false ? (
        <Note theme={theme}>Stopped without shutting its Docker down first: databases recover on the next start.</Note>
      ) : null}
      {action.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(action.error)}
        </Note>
      ) : null}
    </View>
  );
}

function loginView(agent: AgentStatus, stateHome: string): { tone: Tone; label: string; detail: string; command: string | null } {
  // Codex signs in with a ChatGPT account through sbx's OAuth flow.
  const command = `XDG_STATE_HOME=${stateHome} sbx secret set ${agent.login.service}${agent.id === "codex" ? " --oauth" : ""}`;
  // Claude gets the secret's marker at every session; other agents take it from their kit at Update.
  if (agent.id === "claude") {
    return agent.login.stored
      ? {
          tone: "success",
          label: "Signed in",
          detail: "Through your Claude settings when they have a login, else the sbx anthropic secret.",
          command: null,
        }
      : {
          tone: "neutral",
          label: "Claude settings",
          detail: "Signs in through your Claude settings. Without a login there, store the sbx anthropic secret:",
          command,
        };
  }
  return agent.login.stored
    ? { tone: "success", label: "Signed in", detail: `Through the sbx ${agent.login.service} secret.`, command: null }
    : { tone: "warning", label: "No login", detail: `Store the sbx ${agent.login.service} secret, then press Update:`, command };
}

function AgentList({ status, theme, compact }: { status: Status; theme: Theme; compact: boolean }) {
  const configure = useConfigureAgent();
  // A catalog is created from sbx's kit image: Configure and Update ask before downloading it.
  const consent = useDownloadConsent();
  const shown = status.agents.filter((agent) => agent.enabled || agent.provider.configured);
  if (shown.length === 0) {
    return (
      <Empty
        theme={theme}
        title="No agents turned on"
        detail="Turn Claude or Codex on in the plugin settings to add it to the + menu."
      />
    );
  }
  return (
    <>
      <DownloadConsentPrompt consent={consent} theme={theme} standing />
      <Columns compact={compact}>
        {shown.map((agent) => (
          <Column key={agent.id} compact={compact}>
            <AgentCard
              agent={agent}
              stateHome={status.stateHome}
              theme={theme}
              busy={configure.isPending}
              configuring={configure.isPending && configure.variables?.agent === agent.id}
              onConfigure={(update) => consent.request(() => configure.mutate({ agent: agent.id, update }))}
            />
          </Column>
        ))}
      </Columns>
      {configure.isPending ? (
        <Note theme={theme}>Setting up the catalog sandbox; the first time downloads sbx's kit for the agent.</Note>
      ) : null}
      {configure.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(configure.error)}
        </Note>
      ) : null}
    </>
  );
}

function AgentCard({
  agent,
  stateHome,
  theme,
  busy,
  configuring,
  onConfigure,
}: {
  agent: AgentStatus;
  stateHome: string;
  theme: Theme;
  busy: boolean;
  configuring: boolean;
  onConfigure(update: boolean): void;
}) {
  const view = agentView(agent);
  const login = loginView(agent, stateHome);
  const ready = agentReady(agent);
  return (
    <Section
      theme={theme}
      overline={agent.providerId}
      title={agent.label}
      aside={<Pill theme={theme} tone={view.tone} dot label={view.label} />}
    >
      <View style={{ gap: 0 }}>
        <ListRow
          theme={theme}
          first
          title="CLI version"
          detail={agent.catalog.cliVersion ?? "Known once the catalog sandbox answers"}
          aside={agent.catalog.cliVersion ? <Pill theme={theme} label="From sbx's kit" /> : null}
        />
        <ListRow
          theme={theme}
          title="Catalog sandbox"
          detail={<Text style={mono(theme, 12, true)}>{agent.catalog.name}</Text>}
          aside={
            <Pill
              theme={theme}
              tone={agent.catalog.exists ? "success" : "neutral"}
              dot
              label={agent.catalog.exists ? "Created" : "Not created"}
            />
          }
        />
        <ListRow
          theme={theme}
          title="Provider"
          detail={
            agent.provider.current
              ? "Registered in Paseo"
              : agent.provider.configured
                ? "Points at an older launcher"
                : "Not registered"
          }
        />
        <ListRow
          theme={theme}
          title="Login"
          detail={login.detail}
          aside={<Pill theme={theme} tone={login.tone} dot label={login.label} />}
        />
      </View>
      {login.command ? <Code theme={theme} value={login.command} /> : null}
      <View style={{ gap: 6 }}>
        <Text style={kicker(theme)}>Add it to a template</Text>
        <Code theme={theme} value={agent.install} />
      </View>
      {agent.enabled ? (
        <Actions>
          <Button
            theme={theme}
            kind={ready ? "secondary" : "primary"}
            label={ready ? "Update" : "Configure"}
            busy={configuring}
            disabled={busy}
            onPress={() => onConfigure(ready)}
          />
          <Note theme={theme}>
            {ready ? "Recreates the catalog from sbx's latest kit." : "Registers the provider and creates the catalog sandbox."}
          </Note>
        </Actions>
      ) : (
        <Note theme={theme}>Off in the plugin settings: agents created with it keep their provider.</Note>
      )}
    </Section>
  );
}

function TemplateList({
  templates,
  loaded,
  error,
  theme,
  compact,
}: {
  templates: TemplateSummary[];
  loaded: boolean;
  error: unknown;
  theme: Theme;
  compact: boolean;
}) {
  const remove = useRemoveTemplate();
  if (error)
    return (
      <Note theme={theme} tone="danger">
        {errorMessage(error)}
      </Note>
    );
  if (!loaded) return <Text style={text(theme, 13, "400", true)}>Listing templates…</Text>;
  if (templates.length === 0)
    return (
      <Empty theme={theme} title="No templates yet" detail="Prepare one from a workspace's Sandbox panel, in its Template tab." />
    );
  const total = templates.reduce((sum, template) => sum + (template.sizeBytes ?? 0), 0);
  return (
    <>
      <Figures>
        <Stat
          theme={theme}
          label="Templates"
          value={String(templates.length)}
          detail={`${templates.filter((template) => template.users.length > 0 || template.sandboxes.length > 0).length} in use`}
        />
        <Stat theme={theme} label="Total size" value={formatBytes(total)} detail="Layers they share count in each" />
      </Figures>
      <Section theme={theme} title="Saved templates" overline={plural(templates.length, "template")} gap={4}>
        <View role="list">
          {templates.map((template, index) => (
            <ListRow
              key={template.ref}
              theme={theme}
              first={index === 0}
              monospace
              stacked={compact}
              title={shortRef(template.ref)}
              detail={
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                  <Pill theme={theme} label={formatBytes(template.sizeBytes)} />
                  {template.users.map((user) => (
                    <Pill
                      key={user}
                      theme={theme}
                      tone="accent"
                      label={user === "default" ? "Default" : baseName(repoPath(user))}
                    />
                  ))}
                  {template.sandboxes.length > 0 ? (
                    <Pill
                      theme={theme}
                      label={`${plural(template.sandboxes.length, "sandbox", "sandboxes")} ${template.sandboxes.length === 1 ? "runs" : "run"} it`}
                    />
                  ) : null}
                  {template.users.length === 0 && template.sandboxes.length === 0 ? <Pill theme={theme} label="Unused" /> : null}
                </View>
              }
              aside={
                // Only what nothing uses: no setting picks it and no sandbox runs it.
                template.users.length === 0 && template.sandboxes.length === 0 ? (
                  <ConfirmButton
                    theme={theme}
                    small
                    label="Remove"
                    confirmLabel="Confirm remove"
                    busy={remove.isPending && remove.variables === template.ref}
                    disabled={remove.isPending}
                    onConfirm={() => remove.mutate(template.ref)}
                  />
                ) : null
              }
            />
          ))}
        </View>
      </Section>
      {remove.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(remove.error)}
        </Note>
      ) : null}
    </>
  );
}

function LegacyOverrides({ theme }: { theme: Theme }) {
  const settings = useSettings(sandboxSettings);
  const invalidate = useInvalidateAll();
  if (settings.status !== "ready") return null;
  const entries = Object.entries(settings.values.legacyOverrides);
  async function drop(key: string) {
    if (settings.status !== "ready") return;
    const legacyOverrides = { ...settings.values.legacyOverrides };
    delete legacyOverrides[key];
    await settings.save({ ...settings.values, legacyOverrides }, settings.revision);
    invalidate();
  }
  return (
    <Section theme={theme} tone="warning" overline="From an older plugin version" title="Settings to reassign" gap={6}>
      <Note theme={theme}>
        Per-sandbox settings that could not move to a single repository. Set them again in the repository's Sandbox panel, then
        remove them here.
      </Note>
      <View role="list">
        {entries.map(([key, override], index) => (
          <ListRow
            key={key}
            theme={theme}
            first={index === 0}
            monospace
            title={key}
            detail={[
              override.reason === "conflict"
                ? "Conflicts with another worktree"
                : override.reason === "workspace"
                  ? "Per workspace"
                  : "Unresolved",
              override.memoryGiB ? `${override.memoryGiB} GiB` : null,
              override.mounts.length > 0 ? `mounts: ${override.mounts.join(", ")}` : null,
              override.envNames.length > 0 ? `variables: ${override.envNames.join(", ")}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            aside={
              <ConfirmButton theme={theme} small label="Remove" confirmLabel="Confirm remove" onConfirm={() => void drop(key)} />
            }
          />
        ))}
      </View>
    </Section>
  );
}
