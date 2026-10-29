import { openExternalUrl } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/ui";
import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { MCP_HEADER_PATTERN, MCP_NAME_PATTERN, mcpNameFromUrl } from "../shared/mcp";
import type { McpServerView, SignInView } from "../shared/rpc";
import { errorMessage, mcpStatusView, plural } from "./format";
import { Empty, Figures, Frame, Grid, StatusChip } from "./frame";
import {
  Actions,
  Button,
  Code,
  ConfirmButton,
  Field,
  Meter,
  Note,
  Pill,
  Section,
  Stat,
  SwitchRow,
  Toggle,
  figures,
  kicker,
  mono,
  text,
  tint,
  toneColor,
  type Theme,
  type Tone,
} from "./kit";
import { mcpLoadState, type PanelTabProps } from "./panel";
import { useAddMcpServer, useMcpChoices, useMcpServers, useMcpSignIn, useRemoveMcpServer, useStatus } from "./queries";

/** MCP servers: registered in the Docker Sandboxes screen, chosen per repository in the workspace panel. */

const ISSUES = "https://github.com/drungrin/paseo-sbx/issues";

const AUTH_LABEL: Record<McpServerView["auth"], string> = {
  oauth: "Signs in with OAuth",
  "api-key": "API key",
  none: "No sign-in",
};

/** A prefilled issue, with paths under a home folder shortened so no user name is posted. */
function issueUrl(problem: string, sbxVersion: string | null): string {
  const redacted = problem.replace(/\/(home|Users)\/[^/\s]+/g, "~");
  const title = `MCP state not recognized with sbx ${sbxVersion ?? "(unknown version)"}`;
  const body = [
    "paseo-sbx could not read what sbx reports about MCP servers.",
    "",
    `sbx: ${sbxVersion ?? "unknown"}`,
    "",
    "```",
    redacted,
    "```",
  ].join("\n");
  return `${ISSUES}/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/**
 * sbx keeps no public record of what a local sandbox's gateway loaded, so the plugin reads sbx's
 * own; this says when that record (or sbx's output) changed shape, and how to report it.
 */
export function FormatHint({ problem, theme }: { problem: string; theme: Theme }) {
  const status = useStatus();
  const version = status.data?.sbx.version ?? null;
  return (
    <Section theme={theme} tone="warning" overline="sbx changed" title="Part of what sbx reports could not be read">
      <Text style={text(theme, 13, "400", true)}>
        {`${version ? `sbx ${version}` : "This sbx"} keeps its MCP records in a shape this plugin version does not know, so it cannot tell which servers are loaded where. Turning servers on and off still works. Report it, so the plugin can follow:`}
      </Text>
      <Code theme={theme} value={problem.replace(/\/(home|Users)\/[^/\s]+/g, "~")} />
      <Actions>
        <Button
          theme={theme}
          small
          kind="primary"
          label="Report on GitHub"
          onPress={() => void openExternalUrl(issueUrl(problem, version))}
        />
        <Note theme={theme}>Opens a prefilled issue; nothing is sent until you submit it.</Note>
      </Actions>
    </Section>
  );
}

export function McpServersTab({
  theme,
  compact,
  header,
  stateHome,
}: {
  theme: Theme;
  compact: boolean;
  header: { status: ReactNode; actions: ReactNode };
  stateHome: string | null;
}) {
  const servers = useMcpServers();
  const choices = useMcpChoices();
  const signIn = useMcpSignIn();
  const remove = useRemoveMcpServer();
  const [error, setError] = useState<string | null>(null);
  const global = choices.settings.status === "ready" ? choices.settings.values.mcpGlobal : [];
  const data = servers.data;
  const ready = data?.servers.filter((server) => server.status === "ready").length ?? 0;

  function attempt(action: Promise<unknown>) {
    setError(null);
    action.catch((caught) => setError(errorMessage(caught)));
  }

  return (
    <Frame
      theme={theme}
      compact={compact}
      title="MCP servers"
      description="Tools from remote MCP servers for the agents in your sandboxes, served by each sandbox's sbx gateway."
      {...header}
      notes={[
        "sbx keeps each server's sign-in or API key on this host and adds it to the gateway's requests: agents use the tools without ever holding a token.",
        "On for all sandboxes loads a server into every sandbox, now and as new ones are created. A workspace's Sandbox dashboard turns servers on or off for its repository.",
        "Turning a server off unloads it at once from running sandboxes, and from stopped ones when they next start.",
        "Agents can load any server registered here themselves, with the gateway's mcp-find and mcp-add tools.",
        "Only remote servers: a local one would run on this host, outside every sandbox.",
      ]}
    >
      {servers.error ? (
        <Section theme={theme} tone="danger" overline="Could not list the MCP servers">
          <Text style={text(theme, 13)}>{errorMessage(servers.error)}</Text>
        </Section>
      ) : null}
      {data?.unrecognized ? <FormatHint problem={data.unrecognized} theme={theme} /> : null}
      {signIn.view ? (
        <SignInCard
          view={signIn.view}
          theme={theme}
          finishing={signIn.finish.isPending}
          finishError={signIn.finish.error ? errorMessage(signIn.finish.error) : null}
          onFinish={(address) => signIn.finish.mutate(address)}
          onRetry={() => signIn.start.mutate(signIn.view?.server ?? "")}
          onClose={signIn.close}
        />
      ) : null}
      {signIn.start.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(signIn.start.error)}
        </Note>
      ) : null}
      {!data ? (
        servers.error ? null : (
          <Text accessibilityLiveRegion="polite" style={text(theme, 13, "400", true)}>
            Reading the MCP servers…
          </Text>
        )
      ) : data.servers.length === 0 ? (
        <Empty
          theme={theme}
          title="No MCP servers yet"
          detail="Add one below. Its sign-in or API key stays with sbx, on this host."
        />
      ) : (
        <>
          <Figures>
            <Stat theme={theme} label="Servers" value={String(data.servers.length)} detail={`${ready} ready`} />
            <Stat
              theme={theme}
              label="For all sandboxes"
              value={String(data.servers.filter((server) => global.includes(server.name)).length)}
              detail="The rest load where a repository turns them on"
            />
            <Stat theme={theme} label="Sandboxes" value={String(data.sandboxes)} detail="Working sandboxes they load into" />
          </Figures>
          <Grid
            compact={compact}
            items={data.servers}
            keyOf={(server) => server.name}
            render={(server) => (
              <ServerCard
                server={server}
                sandboxes={data.sandboxes}
                global={global.includes(server.name)}
                stateHome={stateHome}
                theme={theme}
                signingIn={
                  (signIn.start.isPending && signIn.start.variables === server.name) ||
                  (signIn.view?.status === "waiting" && signIn.view.server === server.name)
                }
                removing={remove.isPending && remove.variables === server.name}
                onGlobal={(on) => attempt(choices.setGlobal(server.name, on))}
                onSignIn={() => signIn.start.mutate(server.name)}
                onRemove={() => attempt(remove.mutateAsync(server.name).then(() => choices.forget(server.name)))}
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
      <AddServer
        theme={theme}
        compact={compact}
        onAdded={async (server, everywhere) => {
          if (everywhere) await choices.setGlobal(server.name, true);
          if (server.status === "needs-auth") signIn.start.mutate(server.name);
        }}
      />
    </Frame>
  );
}

function ServerCard({
  server,
  sandboxes,
  global,
  stateHome,
  theme,
  signingIn,
  removing,
  onGlobal,
  onSignIn,
  onRemove,
}: {
  server: McpServerView;
  sandboxes: number;
  global: boolean;
  stateHome: string | null;
  theme: Theme;
  signingIn: boolean;
  removing: boolean;
  onGlobal(on: boolean): void;
  onSignIn(): void;
  onRemove(): void;
}) {
  const status = mcpStatusView(server);
  const loaded = server.loadedIn.length;
  return (
    <Section
      theme={theme}
      overline={AUTH_LABEL[server.auth]}
      title={server.name}
      aside={<Pill theme={theme} tone={status.tone} dot label={status.label} />}
    >
      {server.url ? (
        <Text selectable numberOfLines={1} style={mono(theme, 12, true)}>
          {server.url}
        </Text>
      ) : null}
      <SwitchRow
        theme={theme}
        label="On for all sandboxes"
        hint={global ? "Loads into every sandbox, existing and new" : "Loads where a repository turns it on"}
        value={global}
        onValueChange={onGlobal}
      />
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={kicker(theme)}>Loaded</Text>
          <Text style={{ ...text(theme, 12, "500", true), ...figures }}>
            {sandboxes === 0 ? "No sandboxes yet" : `${loaded} of ${plural(sandboxes, "sandbox", "sandboxes")}`}
          </Text>
        </View>
        <Meter theme={theme} value={loaded} max={sandboxes} color={toneColor(theme, "accent")} />
      </View>
      {server.status === "needs-secret" && server.nextStep ? (
        <View style={{ gap: 6 }}>
          <Note theme={theme}>Its API key is not stored. Store it on the Paseo host:</Note>
          <Code theme={theme} value={stateHome ? `XDG_STATE_HOME=${stateHome} ${server.nextStep}` : server.nextStep} />
        </View>
      ) : null}
      {server.status === "needs-auth" ? (
        <Note theme={theme}>Until you sign in, agents see only its sign-in tool, which cannot finish without you.</Note>
      ) : null}
      <Actions>
        {server.auth === "oauth" ? (
          <Button
            theme={theme}
            small
            kind={server.status === "needs-auth" ? "primary" : "secondary"}
            label={server.status === "needs-auth" ? "Sign in" : "Sign in again"}
            busy={signingIn}
            onPress={onSignIn}
          />
        ) : null}
        <ConfirmButton theme={theme} small label="Remove" confirmLabel="Confirm remove" busy={removing} onConfirm={onRemove} />
      </Actions>
    </Section>
  );
}

function Step({ number, title, theme, children }: { number: number; title: string; theme: Theme; children: ReactNode }) {
  const accent = toneColor(theme, "accent");
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: tint(theme, accent, 0.18),
          }}
        >
          <Text style={{ ...text(theme, 11, "700"), color: accent }}>{number}</Text>
        </View>
        <Text style={text(theme, 13, "600")}>{title}</Text>
      </View>
      <View style={{ gap: 8, paddingLeft: 28 }}>{children}</View>
    </View>
  );
}

const SIGN_IN_CHIP: Record<SignInView["status"], { label: string; tone: Tone; moving: boolean }> = {
  waiting: { label: "Waiting for you", tone: "accent", moving: true },
  done: { label: "Signed in", tone: "success", moving: false },
  failed: { label: "Failed", tone: "danger", moving: false },
  cancelled: { label: "Cancelled", tone: "neutral", moving: false },
};

/**
 * sbx's sign-in, on any device: open the provider's page there, then paste back the address it
 * sends the browser to, which only the Paseo host can open. On the host's own browser it ends alone.
 */
function SignInCard({
  view,
  theme,
  finishing,
  finishError,
  onFinish,
  onRetry,
  onClose,
}: {
  view: SignInView;
  theme: Theme;
  finishing: boolean;
  finishError: string | null;
  onFinish(address: string): void;
  onRetry(): void;
  onClose(): void;
}) {
  const [address, setAddress] = useState("");
  const [copied, setCopied] = useState(false);
  const chip = SIGN_IN_CHIP[view.status];
  const waiting = view.status === "waiting";
  const tone: Tone = view.status === "done" ? "success" : view.status === "failed" ? "danger" : "accent";
  return (
    <Section
      theme={theme}
      tone={tone}
      overline="Sign-in"
      title={`Sign in to ${view.server}`}
      aside={<StatusChip theme={theme} label={chip.label} tone={chip.tone} moving={chip.moving} />}
    >
      {waiting && view.url ? (
        <>
          <Step number={1} title="Open the sign-in page and allow access" theme={theme}>
            <Text selectable numberOfLines={3} style={mono(theme, 12, true)}>
              {view.url}
            </Text>
            <Actions>
              <Button theme={theme} small kind="primary" label="Open link" onPress={() => void openExternalUrl(view.url ?? "")} />
              <Button
                theme={theme}
                small
                label={copied ? "Copied" : "Copy link"}
                onPress={() =>
                  void copyText(view.url ?? "")
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false))
                }
              />
            </Actions>
          </Step>
          {view.callbackOrigin ? (
            <Step number={2} title="Paste the address the browser ends on" theme={theme}>
              <Text style={text(theme, 12, "400", true)}>
                {`Off the Paseo host, the provider then sends the browser to ${view.callbackOrigin}, a page that does not load there. Copy its whole address from the address bar. On the host's own browser, the sign-in finishes by itself.`}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 8 }}>
                <Field
                  theme={theme}
                  label="Address the browser ended on"
                  monospace
                  value={address}
                  onChangeText={setAddress}
                  placeholder={`${view.callbackOrigin}/callback?code=…&state=…`}
                  error={finishError}
                  onSubmit={() => (address.trim() ? onFinish(address) : undefined)}
                />
                <View style={{ paddingTop: 22 }}>
                  <Button
                    theme={theme}
                    kind="primary"
                    label="Finish sign-in"
                    busy={finishing}
                    disabled={!address.trim()}
                    onPress={() => onFinish(address)}
                  />
                </View>
              </View>
            </Step>
          ) : null}
        </>
      ) : waiting ? (
        <Text style={text(theme, 13, "400", true)}>Continue in the browser that opened on the Paseo host.</Text>
      ) : view.status === "done" ? (
        <Text
          style={text(theme, 13)}
        >{`Signed in. Agents reach ${view.server} through the gateway; the token stays with sbx.`}</Text>
      ) : view.status === "failed" ? (
        <Note theme={theme} tone="danger">
          {view.error ?? "The sign-in failed."}
        </Note>
      ) : (
        <Text style={text(theme, 13, "400", true)}>The sign-in was cancelled.</Text>
      )}
      <Actions>
        {view.status === "failed" ? <Button theme={theme} small kind="primary" label="Try again" onPress={onRetry} /> : null}
        <Button theme={theme} small kind="quiet" label={waiting ? "Cancel" : "Close"} onPress={onClose} />
      </Actions>
    </Section>
  );
}

function AddServer({
  theme,
  compact,
  onAdded,
}: {
  theme: Theme;
  compact: boolean;
  onAdded(server: McpServerView, everywhere: boolean): Promise<void>;
}) {
  const add = useAddMcpServer();
  const [url, setUrl] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [auth, setAuth] = useState<"oauth" | "api-key">("oauth");
  const [header, setHeader] = useState("Authorization");
  const [key, setKey] = useState("");
  const [everywhere, setEverywhere] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Named after the address until you type a name of your own.
  const shownName = name ?? mcpNameFromUrl(url);
  const nameError = shownName && !MCP_NAME_PATTERN.test(shownName) ? "Letters, digits, dots, dashes and underscores" : null;
  const headerError = header && !MCP_HEADER_PATTERN.test(header) ? "Letters, digits and dashes" : null;
  const complete =
    url.trim() !== "" &&
    shownName !== "" &&
    !nameError &&
    (auth === "oauth" || (key.trim() !== "" && header !== "" && !headerError));

  async function submit() {
    if (!complete || add.isPending) return;
    setError(null);
    try {
      const server = await add.mutateAsync({
        name: shownName,
        url: url.trim(),
        apiKey: auth === "api-key" ? { header: header.trim(), value: key } : null,
      });
      setUrl("");
      setName(null);
      setKey("");
      await onAdded(server, everywhere);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const row = { flexDirection: compact ? ("column" as const) : ("row" as const), gap: 12 };
  return (
    <Section theme={theme} overline="Remote MCP server" title="Add a server">
      <View style={row}>
        <Field
          theme={theme}
          label="Address"
          monospace
          value={url}
          onChangeText={setUrl}
          placeholder="https://mcp.example.com/mcp"
          hint="Its HTTP endpoint, https only"
        />
        <Field
          theme={theme}
          label="Name"
          monospace
          width={compact ? undefined : 200}
          value={shownName}
          onChangeText={setName}
          placeholder="example"
          error={nameError}
          hint="How sbx and the agents call it"
        />
      </View>
      <View style={{ gap: 8 }}>
        <Text style={text(theme, 12, "600", true)}>Signs in with</Text>
        <Toggle<"oauth" | "api-key">
          theme={theme}
          label="Signs in with"
          options={[
            { value: "oauth", label: "Sign-in, if it asks" },
            { value: "api-key", label: "API key" },
          ]}
          value={auth}
          onChange={setAuth}
        />
        <Note theme={theme}>
          {auth === "oauth"
            ? "A server that asks for a sign-in shows its page right after you add it."
            : "sbx keeps the key on this host and adds it to every request: it never enters a sandbox."}
        </Note>
      </View>
      {auth === "api-key" ? (
        <View style={row}>
          <Field
            theme={theme}
            label="Header"
            monospace
            width={compact ? undefined : 200}
            value={header}
            onChangeText={setHeader}
            error={headerError}
            hint={header.toLowerCase() === "authorization" ? "Sent as Bearer and the key" : "Sent with the key as it is"}
          />
          <Field
            theme={theme}
            label="API key"
            secure
            value={key}
            onChangeText={setKey}
            placeholder="Paste the key"
            onSubmit={() => void submit()}
          />
        </View>
      ) : null}
      <SwitchRow
        theme={theme}
        label="On for all sandboxes"
        hint="Loads it into every sandbox, now and into new ones. Off, each repository turns it on in its Sandbox dashboard."
        value={everywhere}
        onValueChange={setEverywhere}
      />
      <Actions>
        <Button
          theme={theme}
          kind="primary"
          label="Add server"
          busy={add.isPending}
          disabled={!complete}
          onPress={() => void submit()}
        />
      </Actions>
      {error ? (
        <Note theme={theme} tone="danger">
          {error}
        </Note>
      ) : null}
    </Section>
  );
}

/** One server's choice for the repository: the switch, where it stands in the sandbox, and whose choice it is. */
function ChoiceCard({
  server,
  data,
  choice,
  global,
  ready,
  theme,
  onChoose,
}: {
  server: McpServerView;
  data: PanelTabProps["data"];
  choice: boolean | undefined;
  global: boolean;
  ready: boolean;
  theme: Theme;
  onChoose(on: boolean | null): void;
}) {
  const on = choice ?? global;
  const state = mcpLoadState(data, server.name, on);
  const status = mcpStatusView(server);
  return (
    <Section
      theme={theme}
      overline={AUTH_LABEL[server.auth]}
      title={server.name}
      aside={<Pill theme={theme} tone={status.tone} dot label={status.label} />}
    >
      {server.url ? (
        <Text selectable numberOfLines={1} style={mono(theme, 12, true)}>
          {server.url}
        </Text>
      ) : null}
      <SwitchRow
        theme={theme}
        label="On for this repository"
        value={on}
        disabled={!ready}
        onValueChange={(next) => onChoose(next)}
        hint={
          <Text
            numberOfLines={3}
            style={{
              ...text(theme, 12, "400", state.tone === "neutral"),
              ...(state.tone === "neutral" ? {} : { color: toneColor(theme, state.tone) }),
            }}
          >
            {state.label}
          </Text>
        }
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Pill
          theme={theme}
          tone={choice === undefined ? "neutral" : "accent"}
          label={choice === undefined ? (global ? "On for all sandboxes" : "Off by default") : "Set for this repository"}
        />
        {choice !== undefined ? (
          <Button theme={theme} small kind="quiet" label="Use the default" onPress={() => onChoose(null)} />
        ) : null}
      </View>
    </Section>
  );
}

export function McpTab({ data, theme, compact, header }: PanelTabProps) {
  const servers = useMcpServers();
  const choices = useMcpChoices();
  const [error, setError] = useState<string | null>(null);
  const values = choices.settings.status === "ready" ? choices.settings.values : null;
  const own = values?.repos[data.repoKey]?.mcp ?? {};
  const list = servers.data?.servers ?? null;

  function choose(name: string, on: boolean | null) {
    setError(null);
    choices.setRepo(data.repoKey, name, on).catch((caught) => setError(errorMessage(caught)));
  }

  return (
    <Frame
      theme={theme}
      compact={compact}
      title="MCP servers"
      description="Which MCP servers this repository's sandboxes load into their gateway."
      {...header}
      notes={[
        "A switch here is this repository's choice. Use the default goes back to the server's own setting, in Docker Sandboxes → MCP servers.",
        "Turning a server on loads it at once, a stopped sandbox included. Turning it off unloads it at once, or when a stopped sandbox next starts.",
        "Agents can load other registered servers themselves, with the gateway's mcp-add tool; those show as loaded by an agent.",
      ]}
    >
      {data.mcp.unreadable ? <FormatHint problem={data.mcp.unreadable} theme={theme} /> : null}
      {servers.error ? (
        <Section theme={theme} tone="danger" overline="Could not list the MCP servers">
          <Text style={text(theme, 13)}>{errorMessage(servers.error)}</Text>
        </Section>
      ) : null}
      {!list ? (
        servers.error ? null : (
          <Text accessibilityLiveRegion="polite" style={text(theme, 13, "400", true)}>
            Reading the MCP servers…
          </Text>
        )
      ) : list.length === 0 ? (
        <Empty
          theme={theme}
          title="No MCP servers yet"
          detail="Register them in Docker Sandboxes → MCP servers, in the sidebar. Then choose here which ones this repository loads."
        />
      ) : (
        <Grid
          compact={compact}
          items={list}
          keyOf={(server) => server.name}
          render={(server) => (
            <ChoiceCard
              server={server}
              data={data}
              choice={own[server.name]}
              global={values?.mcpGlobal.includes(server.name) ?? false}
              ready={values !== null}
              theme={theme}
              onChoose={(on) => choose(server.name, on)}
            />
          )}
        />
      )}
      {error ? (
        <Note theme={theme} tone="danger">
          {error}
        </Note>
      ) : null}
    </Frame>
  );
}
