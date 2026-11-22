import { useState } from "react";
import { Text, View } from "react-native";
import type { CliId } from "../shared/cli-tools";
import type { RepoConfig } from "../shared/settings";
import { errorMessage, plural } from "./format";
import { Frame, Grid } from "./frame";
import { Actions, Button, Code, Field, ListRow, Note, Pill, Section, SwitchRow, Toggle, ago, mono, text, useNow, type Theme, type Tone } from "./kit";
import type { PanelTabProps } from "./panel";
import {
  useCliInstall,
  useCliLatest,
  useCliRemoveUnused,
  useCliRepo,
  useCliTest,
  useCliToken,
  useCliTools,
  useRepoSettings,
  type CliRepoView,
  type CliTestView,
  type CliToolsView,
} from "./queries";

/** Additional CLIs: agent CLIs a repository's sandboxes get besides their session's agent. */

const TAB_NOTES = [
  "Each CLI's settings, plugins, skills and history are the sandbox's own, in its config folder, and survive a recreation. Only the credential can be shared.",
  "Shared: one sign-in per CLI for the sandboxes of every repository that shares. Any agent in those sandboxes can read it. Per sandbox: the sandbox signs in on its own and nothing leaves it.",
  "Sign in from the workspace's Sandbox terminal with the command on each card; Claude takes a token from claude setup-token instead.",
  "Sessions get the CLIs as commands on their PATH. A session already running keeps what it started with: a change reaches the next one.",
  "A sandbox whose template runs Claude never gets an additional claude, and one that runs Codex never an additional codex.",
  "The plugin installs and updates the CLIs in Docker Sandboxes → Agents; the plugin settings turn them on for every repository.",
];

export function CliTab({ data, workspaceId, directory, theme, compact, header }: PanelTabProps) {
  const repoView = useCliRepo(workspaceId, directory);
  const { settings, repo, save } = useRepoSettings(data.repoKey);
  const [error, setError] = useState<string | null>(null);
  const ready = settings.status === "ready" && repo !== null;
  const view = repoView.data;

  function patch(build: (repo: RepoConfig) => Partial<RepoConfig>) {
    if (!repo) return;
    setError(null);
    save(build(repo)).catch((caught) => setError(errorMessage(caught)));
  }
  const choose = (id: CliId, on: boolean | null) =>
    patch((current) => {
      const choices = { ...current.cliTools };
      if (on === null) delete choices[id];
      else choices[id] = on;
      return { cliTools: Object.keys(choices).length > 0 ? choices : undefined };
    });

  return (
    <Frame
      theme={theme}
      compact={compact}
      title="CLIs"
      description="Agent CLIs this repository's sandboxes get besides the session's agent, and where they sign in."
      {...header}
      notes={TAB_NOTES}
    >
      {repoView.error ? (
        <Section theme={theme} tone="danger" overline="Could not read the CLIs">
          <Text style={text(theme, 13)}>{errorMessage(repoView.error)}</Text>
        </Section>
      ) : null}
      {!view ? (
        repoView.error ? null : (
          <Text accessibilityLiveRegion="polite" style={text(theme, 13, "400", true)}>
            Reading the repository's CLIs…
          </Text>
        )
      ) : (
        <>
          <Scope view={view} ready={ready} theme={theme} onChoose={(scope) => patch(() => ({ cliScope: scope ?? undefined }))} />
          <Grid
            compact={compact}
            items={view.clis}
            keyOf={(cli) => cli.id}
            render={(cli) => (
              <RepoCliCard
                cli={cli}
                view={view}
                ready={ready}
                theme={theme}
                workspaceId={workspaceId}
                directory={directory}
                onChoose={(on) => choose(cli.id, on)}
              />
            )}
          />
        </>
      )}
      {error ? (
        <Note theme={theme} tone="danger">
          {error}
        </Note>
      ) : null}
    </Frame>
  );
}

function Scope({ view, ready, theme, onChoose }: { view: CliRepoView; ready: boolean; theme: Theme; onChoose(scope: "global" | "sandbox" | null): void }) {
  const pending = view.mount.needed && view.mount.applied === false;
  return (
    <Section
      theme={theme}
      overline="This repository"
      title="Credentials"
      aside={<Pill theme={theme} tone={view.scope === "global" ? "accent" : "neutral"} label={view.scope === "global" ? "Shared" : "Per sandbox"} />}
      gap={10}
    >
      <Toggle
        theme={theme}
        label="Where the CLIs sign in"
        value={view.scope}
        options={[
          { value: "global", label: "Shared" },
          { value: "sandbox", label: "Per sandbox" },
        ]}
        onChange={(scope) => (ready ? onChoose(scope) : undefined)}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Pill
          theme={theme}
          tone={view.repoScope === null ? "neutral" : "accent"}
          label={view.repoScope === null ? `${view.globalScope === "global" ? "Shared" : "Per sandbox"} from the plugin settings` : "Set for this repository"}
        />
        {view.repoScope !== null ? (
          <Button theme={theme} small kind="quiet" label="Use the default" disabled={!ready} onPress={() => onChoose(null)} />
        ) : null}
      </View>
      {view.scope === "global" ? (
        <Note theme={theme} tone="warning">
          Shared credentials are mounted in the sandboxes of every repository that shares them: any agent there can read
          them. Choose per sandbox for repositories whose agents read untrusted material, such as outside pull requests.
        </Note>
      ) : null}
      {pending ? (
        <Note theme={theme} tone="warning">
          The sandbox was created without the shared credentials folder: recreate it from the Overview to sign in with
          them. Until then the CLIs are not signed in here.
        </Note>
      ) : null}
      {!view.mount.needed && view.mount.applied ? (
        <Note theme={theme}>The sandbox still mounts the shared credentials folder: recreate it to remove it.</Note>
      ) : null}
    </Section>
  );
}

const TEST_LABEL: Record<CliTestView["status"], { label: string; tone: Tone }> = {
  ok: { label: "Signed in", tone: "success" },
  login: { label: "Not signed in", tone: "warning" },
  "not-mounted": { label: "State not mounted", tone: "warning" },
  quota: { label: "Usage limit", tone: "warning" },
  missing: { label: "Not installed here", tone: "warning" },
  error: { label: "Failed", tone: "danger" },
};

function cliState(cli: CliRepoView["clis"][number]): { label: string; tone: Tone } {
  if (cli.unavailable) return { label: "Not for this sandbox", tone: "neutral" };
  if (!cli.enabled) return { label: "Off", tone: "neutral" };
  if (!cli.active) return { label: "Not installed", tone: "warning" };
  return cli.signedIn ? { label: "On", tone: "success" } : { label: "Sign in", tone: "warning" };
}

function RepoCliCard({
  cli,
  view,
  ready,
  theme,
  workspaceId,
  directory,
  onChoose,
}: {
  cli: CliRepoView["clis"][number];
  view: CliRepoView;
  ready: boolean;
  theme: Theme;
  workspaceId: string;
  directory: string;
  onChoose(on: boolean | null): void;
}) {
  const test = useCliTest();
  const token = useCliToken();
  const [value, setValue] = useState("");
  const state = cliState(cli);
  const usable = cli.enabled && !cli.unavailable;
  const result = test.data;
  return (
    <Section theme={theme} overline={cli.active ? `Version ${cli.active}` : "Not installed"} title={cli.label} aside={<Pill theme={theme} tone={state.tone} dot label={state.label} />}>
      {cli.unavailable ? (
        <Note theme={theme}>Not offered: {cli.unavailable}.</Note>
      ) : (
        <>
          <SwitchRow theme={theme} label="On for this repository" value={cli.enabled} disabled={!ready} onValueChange={(next) => onChoose(next)} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <Pill
              theme={theme}
              tone={cli.choice === null ? "neutral" : "accent"}
              label={cli.choice === null ? `${cli.global ? "On" : "Off"} from the plugin settings` : "Set for this repository"}
            />
            {cli.choice !== null ? <Button theme={theme} small kind="quiet" label="Use the default" disabled={!ready} onPress={() => onChoose(null)} /> : null}
          </View>
        </>
      )}
      {usable ? (
        <>
          <ListRow
            theme={theme}
            first
            title={view.scope === "global" ? "Shared sign-in" : "This sandbox's sign-in"}
            detail={cli.signedIn ? "A credential is stored; Test checks it from inside the sandbox." : "No credential yet."}
          />
          {cli.credential === "token" ? (
            <View style={{ gap: 8 }}>
              <Text style={text(theme, 12, "400", true)}>
                Run claude setup-token in the Sandbox terminal or on any machine, then paste the token it prints.
              </Text>
              <Field theme={theme} label="Claude token" secure monospace value={value} onChangeText={setValue} placeholder="sk-ant-oat01-…" />
              <Actions>
                <Button
                  theme={theme}
                  small
                  label="Save token"
                  busy={token.isPending}
                  disabled={!value.trim()}
                  onPress={() => token.mutate({ target: { workspaceId, directory }, token: value }, { onSuccess: () => setValue("") })}
                />
              </Actions>
              {token.error ? (
                <Note theme={theme} tone="danger">
                  {errorMessage(token.error)}
                </Note>
              ) : null}
            </View>
          ) : (
            <View style={{ gap: 6 }}>
              <Text style={text(theme, 12, "400", true)}>In this workspace's Sandbox terminal:</Text>
              <Code theme={theme} value={cli.login} />
            </View>
          )}
          <Actions>
            <Button
              theme={theme}
              small
              label="Test"
              busy={test.isPending}
              disabled={view.sandbox.status !== "running" || !cli.active}
              onPress={() => test.mutate({ workspaceId, directory, id: cli.id })}
            />
            {result ? <Pill theme={theme} tone={TEST_LABEL[result.status].tone} dot label={TEST_LABEL[result.status].label} /> : null}
          </Actions>
          {view.sandbox.status !== "running" ? <Note theme={theme}>Test runs in the sandbox: start an agent or the Sandbox terminal first.</Note> : null}
          {result && result.detail ? (
            <Text selectable style={mono(theme, 12, true)}>
              {result.detail}
            </Text>
          ) : null}
          {test.error ? (
            <Note theme={theme} tone="danger">
              {errorMessage(test.error)}
            </Note>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

// --- Docker Sandboxes → Agents ----------------------------------------------------------

const SECTION_NOTES =
  "Each CLI is downloaded from its vendor, checked against its published digest and kept in the plugin's folder, which every sandbox mounts read-only: nothing of it runs on this host, and no sandbox needs a recreation for it. Update installs the vendor's current release; GSD Path's CLI review panel accepts only the versions it qualified.";

export function CliToolsSection({ theme, compact }: { theme: Theme; compact: boolean }) {
  const tools = useCliTools();
  const remove = useCliRemoveUnused();
  const view = tools.data;
  if (tools.error) {
    return (
      <Section theme={theme} tone="danger" overline="Additional CLIs" title="Could not read the CLIs">
        <Text style={text(theme, 13)}>{errorMessage(tools.error)}</Text>
      </Section>
    );
  }
  if (!view) return null;
  const extra = view.tools.reduce((count, tool) => count + tool.versions.filter((version) => version !== tool.active).length, 0);
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 4 }}>
        <Text role="heading" style={text(theme, 16, "600")}>
          Additional CLIs
        </Text>
        <Text style={text(theme, 13, "400", true)}>{SECTION_NOTES}</Text>
      </View>
      {!view.qualified ? (
        <Note theme={theme} tone="warning">
          The CLIs were qualified on x64 hosts only; this host is {view.arch}, so none is installed.
        </Note>
      ) : null}
      <Grid compact={compact} items={view.tools} keyOf={(tool) => tool.id} render={(tool) => <ToolCard tool={tool} view={view} theme={theme} />} />
      <Actions>
        <Button
          theme={theme}
          small
          label="Remove unused versions"
          busy={remove.isPending}
          disabled={extra === 0 || view.running}
          onPress={() => remove.mutate()}
        />
        <Note theme={theme}>
          {extra === 0
            ? "No version waits to be removed."
            : view.running
              ? `${plural(extra, "version")} wait until no sandbox runs.`
              : `${plural(extra, "version")} no CLI uses.`}
        </Note>
      </Actions>
      {remove.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(remove.error)}
        </Note>
      ) : null}
    </View>
  );
}

function toolState(tool: CliToolsView["tools"][number]): { label: string; tone: Tone; moving?: boolean } {
  if (tool.installing) return { label: `Installing ${tool.target ?? ""}`.trim(), tone: "accent", moving: true };
  if (tool.error) return { label: "Install failed", tone: "danger" };
  if (tool.active) return { label: tool.enabled || tool.repos > 0 ? "Installed" : "Installed, off", tone: tool.enabled || tool.repos > 0 ? "success" : "neutral" };
  return tool.enabled || tool.repos > 0 ? { label: "Not installed", tone: "warning" } : { label: "Off", tone: "neutral" };
}

function ToolCard({ tool, view, theme }: { tool: CliToolsView["tools"][number]; view: CliToolsView; theme: Theme }) {
  const install = useCliInstall();
  const latest = useCliLatest();
  const token = useCliToken();
  const now = useNow();
  const [value, setValue] = useState("");
  const state = toolState(tool);
  const newer = latest.data && latest.data.version !== tool.active ? latest.data.version : null;
  const busy = tool.installing || install.isPending;
  return (
    <Section theme={theme} overline={tool.vendor} title={tool.label} aside={<Pill theme={theme} tone={state.tone} dot moving={state.moving} label={state.label} />}>
      <View style={{ gap: 0 }}>
        <ListRow
          theme={theme}
          first
          title="Version"
          detail={tool.active ? `${tool.active}${tool.installedAt ? `, installed ${ago(tool.installedAt, now)}` : ""}` : "None installed"}
          aside={tool.active === tool.pinned ? <Pill theme={theme} label="This release's" /> : null}
        />
        <ListRow theme={theme} title="This plugin release" detail={tool.pinned} />
        <ListRow
          theme={theme}
          title="Turned on"
          detail={tool.enabled ? "For every repository" : tool.repos > 0 ? `By ${plural(tool.repos, "repository", "repositories")}` : "Nowhere"}
        />
        <ListRow
          theme={theme}
          title="Shared sign-in"
          detail={tool.globalCredential ? "A credential is stored" : "None yet"}
          aside={<Pill theme={theme} tone={tool.globalCredential ? "success" : "neutral"} dot label={tool.globalCredential ? "Stored" : "None"} />}
        />
      </View>
      {tool.credential === "token" ? (
        <View style={{ gap: 8 }}>
          <Text style={text(theme, 12, "400", true)}>The shared sign-in is a token from claude setup-token, which you run anywhere and paste here.</Text>
          <Field theme={theme} label="Claude token" secure monospace value={value} onChangeText={setValue} placeholder="sk-ant-oat01-…" />
          <Actions>
            <Button theme={theme} small label="Save token" busy={token.isPending} disabled={!value.trim()} onPress={() => token.mutate({ target: null, token: value }, { onSuccess: () => setValue("") })} />
          </Actions>
          {token.error ? (
            <Note theme={theme} tone="danger">
              {errorMessage(token.error)}
            </Note>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: 6 }}>
          <Text style={text(theme, 12, "400", true)}>Sign in from the Sandbox terminal of a workspace that shares credentials:</Text>
          <Code theme={theme} value={tool.login} />
        </View>
      )}
      {tool.error ? (
        <Text selectable style={mono(theme, 12, true)}>
          {tool.error}
        </Text>
      ) : null}
      {view.qualified ? (
        <Actions>
          {!tool.active ? (
            <Button theme={theme} small kind="primary" label={`Install ${tool.pinned}`} busy={busy} onPress={() => install.mutate({ id: tool.id, release: "pinned" })} />
          ) : newer ? (
            <Button theme={theme} small kind="primary" label={`Install ${newer}`} busy={busy} onPress={() => install.mutate({ id: tool.id, release: "latest" })} />
          ) : (
            <Button theme={theme} small label="Check for updates" busy={latest.isPending} disabled={busy} onPress={() => latest.mutate(tool.id)} />
          )}
          {latest.data && !newer ? <Note theme={theme}>{tool.active} is the vendor's current release.</Note> : null}
          {newer ? <Note theme={theme}>The vendor's current release; sessions get it from their next start.</Note> : null}
        </Actions>
      ) : null}
      {latest.error || install.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(latest.error ?? install.error)}
        </Note>
      ) : null}
      {!view.networkOpen ? (
        <Note theme={theme}>
          The network policy is not open to every host: sandboxes need {tool.hosts.join(", ")}.
        </Note>
      ) : null}
    </Section>
  );
}
