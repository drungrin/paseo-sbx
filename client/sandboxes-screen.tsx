import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { SandboxSummary } from "../shared/rpc";
import { useEnsureProvider, useSandboxAction, useSandboxes, useStatus } from "./queries";
import {
  Button,
  Card,
  ConfirmButton,
  Row,
  Screen,
  Section,
  errorMessage,
  formatMiB,
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
    </Screen>
  );
}

function SandboxCard({ styles, sandbox }: { styles: Styles; sandbox: SandboxSummary }) {
  const action = useSandboxAction();
  return (
    <Card styles={styles}>
      <Row styles={styles} label={sandbox.name} first>
        {sandbox.status}
      </Row>
      {sandbox.memory ? (
        <Row styles={styles} label="Memory">
          {sandbox.memory}
        </Row>
      ) : null}
      <Row styles={styles} label="Workspace">
        <Text style={styles.mono}>{sandbox.workspaces[0] ?? "-"}</Text>
      </Row>
      <View style={[styles.row, styles.actions]}>
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
      {action.error ? <Text style={[styles.error, { padding: 12 }]}>{errorMessage(action.error)}</Text> : null}
    </Card>
  );
}
