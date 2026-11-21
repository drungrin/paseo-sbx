import { useState } from "react";
import { Text, View } from "react-native";
import type { RepoConfig } from "../shared/settings";
import { errorMessage, plural, tildify, homeOf } from "./format";
import { Frame, Grid } from "./frame";
import { Actions, Button, Field, ListRow, Note, Pill, Section, SwitchRow, ago, mono, text, useNow, type Theme, type Tone } from "./kit";
import type { PanelTabProps } from "./panel";
import { useKubeRepo, useKubeTest, useRepoSettings, type KubeRepoView, type KubeTestView } from "./queries";

/** Kubernetes: the host contexts a repository's sandboxes get, chosen per repository over the plugin settings. */

type Context = KubeRepoView["contexts"][number];

const AUTH_LABEL: Record<Context["auth"], string> = {
  "client-certificate": "Client certificate",
  token: "Token",
  "token-file": "Token file",
  basic: "Username and password",
  exec: "Command on the host",
  "auth-provider": "Auth provider",
  none: "No credentials",
};

const NOTES = [
  "Sessions get KUBECONFIG with the sandbox's own ~/.kube/config first and the plugin's file second. What the sandbox writes, such as a k3d cluster or kubectl config use-context, goes to its own file, and its current context wins over the one chosen here.",
  "Sessions' CLAUDE.md names the contexts, says they are real clusters of this host, and which one is the default, if any.",
  "The plugin's file is written at every session and when the Sandbox terminal opens, so a change here reaches the next one, with no recreation. An agent already running keeps the file it read until it reads it again.",
  "A cluster on this host is reached at host.docker.internal, which follows this host on any network, and keeps its address as the TLS name, so the certificate is still checked.",
  "Contexts that sign in with a command or an auth provider (EKS, GKE, kubelogin) are left out: those run on this host.",
  "The global switch and the contexts for every repository are in the plugin settings, under Kubernetes.",
];

export function KubernetesTab({ data, workspaceId, directory, theme, compact, header }: PanelTabProps) {
  const kube = useKubeRepo(workspaceId, directory);
  const { settings, repo, save } = useRepoSettings(data.repoKey);
  const [error, setError] = useState<string | null>(null);
  const ready = settings.status === "ready" && repo !== null;
  const view = kube.data;

  function patch(build: (repo: RepoConfig) => Partial<RepoConfig>) {
    if (!repo) return;
    setError(null);
    save(build(repo)).catch((caught) => setError(errorMessage(caught)));
  }
  const choose = (name: string, on: boolean | null) =>
    patch((current) => {
      const contexts = { ...current.kubeContexts };
      if (on === null) delete contexts[name];
      else contexts[name] = on;
      return { kubeContexts: Object.keys(contexts).length > 0 ? contexts : undefined };
    });
  const setNamespace = (name: string, namespace: string) =>
    patch((current) => {
      const namespaces = { ...current.kubeNamespaces };
      if (namespace.trim()) namespaces[name] = namespace.trim();
      else delete namespaces[name];
      return { kubeNamespaces: Object.keys(namespaces).length > 0 ? namespaces : undefined };
    });

  return (
    <Frame
      theme={theme}
      compact={compact}
      title="Kubernetes"
      description="Which contexts of this host's kubeconfig the repository's sandboxes get."
      {...header}
      notes={NOTES}
    >
      {kube.error ? (
        <Section theme={theme} tone="danger" overline="Could not read the contexts">
          <Text style={text(theme, 13)}>{errorMessage(kube.error)}</Text>
        </Section>
      ) : null}
      {!view ? (
        kube.error ? null : (
          <Text accessibilityLiveRegion="polite" style={text(theme, 13, "400", true)}>
            Reading this host's kubeconfig…
          </Text>
        )
      ) : (
        <>
          <Integration
            view={view}
            ready={ready}
            theme={theme}
            onChoose={(on) => patch(() => ({ kube: on ?? undefined }))}
            onNoDefault={(on) => patch(() => ({ kubeNoDefault: on || undefined }))}
          />
          {view.host.error ? (
            <Section theme={theme} tone="danger" overline="Could not read the kubeconfig" title={tildify(view.host.file, homeOf(data.workspace))}>
              <Text selectable style={text(theme, 13)}>
                {view.host.error}
              </Text>
              <Note theme={theme}>Sessions keep the last contexts the plugin wrote until it can read it again.</Note>
            </Section>
          ) : null}
          {view.missing.length > 0 ? (
            <Section theme={theme} tone="warning" overline="Chosen, but not on this host" title={plural(view.missing.length, "context")}>
              {view.missing.map((name, index) => (
                <ListRow
                  key={name}
                  theme={theme}
                  first={index === 0}
                  title={name}
                  detail="Not in this host's kubeconfig: sessions do not get it."
                  aside={
                    repo?.kubeContexts?.[name] !== undefined ? (
                      <Button theme={theme} small kind="quiet" label="Forget" disabled={!ready} onPress={() => choose(name, null)} />
                    ) : (
                      <Pill theme={theme} label="From the plugin settings" />
                    )
                  }
                />
              ))}
            </Section>
          ) : null}
          {view.contexts.length === 0 && !view.host.error ? (
            <Note theme={theme}>This host's kubeconfig has no contexts.</Note>
          ) : (
            <Grid
              compact={compact}
              items={view.contexts}
              keyOf={(context) => context.name}
              render={(context) => (
                <ContextCard
                  context={context}
                  view={view}
                  ready={ready}
                  theme={theme}
                  onChoose={(on) => choose(context.name, on)}
                  onNamespace={(namespace) => setNamespace(context.name, namespace)}
                  onDefault={(on) => patch(() => ({ kubeCurrent: on ? context.name : undefined }))}
                />
              )}
            />
          )}
          <InSandbox view={view} workspaceId={workspaceId} directory={directory} theme={theme} />
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

function Integration({
  view,
  ready,
  theme,
  onChoose,
  onNoDefault,
}: {
  view: KubeRepoView;
  ready: boolean;
  theme: Theme;
  onChoose(on: boolean | null): void;
  onNoDefault(on: boolean): void;
}) {
  return (
    <Section
      theme={theme}
      overline="This repository"
      title="Kubernetes contexts"
      aside={<Pill theme={theme} tone={view.enabled ? "success" : "neutral"} dot label={view.enabled ? "On" : "Off"} />}
      gap={10}
    >
      <SwitchRow
        theme={theme}
        label="On for this repository"
        value={view.enabled}
        disabled={!ready}
        onValueChange={(next) => onChoose(next)}
        hint="Sessions in this repository's sandboxes get the contexts turned on below."
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Pill
          theme={theme}
          tone={view.repoChoice === null ? "neutral" : "accent"}
          label={view.repoChoice === null ? `${view.global ? "On" : "Off"} from the plugin settings` : "Set for this repository"}
        />
        {view.repoChoice !== null ? (
          <Button theme={theme} small kind="quiet" label="Use the default" disabled={!ready} onPress={() => onChoose(null)} />
        ) : null}
      </View>
      <SwitchRow
        theme={theme}
        label="No default context"
        value={view.noDefault}
        disabled={!ready || !view.enabled}
        onValueChange={onNoDefault}
        hint="kubectl and helm without --context fail (kubectl tries localhost:8080) instead of reaching a host cluster. Worth it when tests in the sandbox create and delete their own clusters: once one is gone, the default would fall back to a host cluster."
      />
      <Note theme={theme} tone="warning">
        The credentials of every context turned on enter the sandbox, unlike sbx's secrets: its agents can do in that
        cluster whatever those credentials allow.
      </Note>
    </Section>
  );
}

function contextState(context: Context, view: KubeRepoView): { label: string; tone: Tone } {
  if (context.unsupported) return { label: "Not available", tone: "warning" };
  if (!view.enabled || !context.on) return { label: "Off", tone: "neutral" };
  const skipped = view.skipped.find((entry) => entry.name === context.name);
  if (skipped) return { label: "Left out", tone: "warning" };
  return view.current === context.name ? { label: "Default context", tone: "success" } : { label: "On", tone: "success" };
}

function ContextCard({
  context,
  view,
  ready,
  theme,
  onChoose,
  onNamespace,
  onDefault,
}: {
  context: Context;
  view: KubeRepoView;
  ready: boolean;
  theme: Theme;
  onChoose(on: boolean | null): void;
  onNamespace(namespace: string): void;
  onDefault(on: boolean): void;
}) {
  const [namespace, setNamespace] = useState(context.repoNamespace ?? "");
  const state = contextState(context, view);
  const usable = view.enabled && !context.unsupported;
  const active = usable && context.on && !view.skipped.some((entry) => entry.name === context.name);
  const moved = context.guestServer !== null && context.guestServer !== context.server;
  const skipped = view.skipped.find((entry) => entry.name === context.name);
  return (
    <Section theme={theme} overline={AUTH_LABEL[context.auth]} title={context.name} aside={<Pill theme={theme} tone={state.tone} dot label={state.label} />}>
      <View style={{ gap: 2 }}>
        <Text selectable numberOfLines={1} style={mono(theme, 12, true)}>
          {context.server ?? "no server"}
        </Text>
        {moved ? (
          <Text selectable numberOfLines={1} style={mono(theme, 12, true)}>
            {`→ ${context.guestServer} in the sandbox`}
          </Text>
        ) : null}
      </View>
      {context.unsupported || skipped ? (
        <Note theme={theme} tone="warning">
          {context.unsupported ?? skipped?.reason}
        </Note>
      ) : null}
      <SwitchRow
        theme={theme}
        label="On for this repository"
        value={context.on}
        disabled={!ready || !usable}
        onValueChange={(next) => onChoose(next)}
        hint={view.enabled ? undefined : "Turn Kubernetes contexts on for this repository first."}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Pill
          theme={theme}
          tone={context.choice === null ? "neutral" : "accent"}
          label={context.choice === null ? (context.global ? "On for every repository" : "Off by default") : "Set for this repository"}
        />
        {context.choice !== null ? (
          <Button theme={theme} small kind="quiet" label="Use the default" disabled={!ready} onPress={() => onChoose(null)} />
        ) : null}
      </View>
      {active ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
            <Field
              theme={theme}
              label="Namespace in this repository"
              value={namespace}
              placeholder={context.namespace ?? "default"}
              monospace
              onChangeText={setNamespace}
              onSubmit={() => onNamespace(namespace)}
            />
            {namespace.trim() !== (context.repoNamespace ?? "") ? (
              <Button theme={theme} small label="Save" disabled={!ready} onPress={() => onNamespace(namespace)} />
            ) : null}
          </View>
          {view.noDefault ? null : <Actions>
            {view.current === context.name ? (
              view.repoCurrent === context.name ? (
                <Button theme={theme} small kind="quiet" label="Use the host's default" disabled={!ready} onPress={() => onDefault(false)} />
              ) : (
                <Text style={text(theme, 12, "400", true)}>The default: the host's current context, or the first one on.</Text>
              )
            ) : (
              <Button theme={theme} small label="Make it the default" disabled={!ready} onPress={() => onDefault(true)} />
            )}
          </Actions>}
        </>
      ) : null}
    </Section>
  );
}

function InSandbox({ view, workspaceId, directory, theme }: { view: KubeRepoView; workspaceId: string; directory: string; theme: Theme }) {
  const test = useKubeTest();
  const now = useNow();
  const written = view.sandbox.written;
  const expected = view.enabled
    ? view.contexts.filter((context) => context.on && !context.unsupported && !view.skipped.some((entry) => entry.name === context.name)).map((context) => context.name)
    : [];
  const stale =
    (written?.contexts ?? []).slice().sort().join(",") !== expected.slice().sort().join(",") ||
    (written !== null && expected.length > 0 && written.current !== view.current);
  const running = view.sandbox.status === "running";
  return (
    <Section theme={theme} overline={view.sandbox.name} title="In the sandbox" gap={10}>
      <ListRow
        theme={theme}
        first
        title={written ? plural(written.contexts.length, "context") : "No contexts yet"}
        detail={
          written
            ? `${written.contexts.join(", ")}${written.current ? ` · default ${written.current}` : ""} · written ${ago(written.writtenAt, now)}`
            : expected.length > 0
              ? "Written when the next session or the Sandbox terminal starts."
              : "Turn contexts on above."
        }
        aside={stale && expected.length + (written?.contexts.length ?? 0) > 0 ? <Pill theme={theme} tone="accent" label="Changes reach the next session" /> : null}
      />
      <Actions>
        <Button
          theme={theme}
          small
          label="Test access"
          busy={test.isPending}
          disabled={!running || !written}
          onPress={() => test.mutate({ workspaceId, directory })}
        />
        {!running ? <Text style={text(theme, 12, "400", true)}>Tests run in a running sandbox.</Text> : null}
      </Actions>
      {test.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(test.error)}
        </Note>
      ) : null}
      {test.data ? <TestResult result={test.data} view={view} theme={theme} /> : null}
    </Section>
  );
}

function TestResult({ result, view, theme }: { result: KubeTestView; view: KubeRepoView; theme: Theme }) {
  const shadowed = (result.own ?? []).filter((name) => result.results.some((entry) => entry.context === name));
  return (
    <View style={{ gap: 8 }}>
      {result.kubectl ? (
        <Text style={text(theme, 12, "400", true)}>{`kubectl ${result.kubectl} in the sandbox`}</Text>
      ) : (
        <Note theme={theme} tone="warning">
          This sandbox has no kubectl, so the plugin asked each cluster itself. Agents need kubectl, or another tool that reads
          KUBECONFIG: install it in the repository's template.
        </Note>
      )}
      {result.error === "no-file" ? (
        <Note theme={theme}>The plugin has not written this sandbox's contexts yet: start a session or the Sandbox terminal.</Note>
      ) : null}
      <View role="list">
        {result.results.map((entry, index) => (
          <ListRow
            key={entry.context}
            theme={theme}
            first={index === 0}
            title={entry.context}
            detail={<Text selectable style={mono(theme, 12, true)}>{entry.detail}</Text>}
            aside={<Pill theme={theme} tone={entry.ok ? "success" : "danger"} dot label={entry.ok ? "Reached" : "Failed"} />}
          />
        ))}
      </View>
      {result.own !== null ? (
        <Text style={text(theme, 12, "400", true)}>
          {result.own.length > 0
            ? `The sandbox's own kubeconfig: ${result.own.join(", ")}${result.ownCurrent ? ` (current ${result.ownCurrent})` : ""}.`
            : "The sandbox's own kubeconfig has no contexts."}
          {result.current ? ` Sessions use ${result.current} by default.` : ""}
        </Text>
      ) : null}
      {shadowed.length > 0 ? (
        <Note theme={theme} tone="warning">
          {`${shadowed.join(", ")} ${shadowed.length === 1 ? "is" : "are"} also in the sandbox's own kubeconfig, which wins: sessions get that entry, not this host's. Remove ${shadowed.length === 1 ? "it" : "them"} there with kubectl config delete-context.`}
        </Note>
      ) : null}
      {result.ownCurrent && view.current && result.ownCurrent !== view.current ? (
        <Note theme={theme}>{`The sandbox chose ${result.ownCurrent} itself, so it is the default there instead of ${view.current}.`}</Note>
      ) : null}
    </View>
  );
}
