import { useRpc, usePaseo, useSettings, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SettingsInput } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { shellCommandRpc } from "../shared/rpc";
import { sandboxSettings } from "../shared/settings";
import { useInvalidateAll, useSandboxAction, useSandboxDescription } from "./queries";
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
} from "./ui";

export function WorkspacePanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme, layout.compact);
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const description = useSandboxDescription(workspaceId, directory);
  const action = useSandboxAction();
  const invalidate = useInvalidateAll();
  const paseo = usePaseo();
  const getShell = useRpc(shellCommandRpc);
  const openShell = useMutation({
    mutationFn: async () => {
      const shell = await getShell({ workspaceId, directory: directory ?? "" });
      await paseo.terminals.create({
        workspaceId,
        name: `sbx ${shell.name}`,
        command: shell.command,
        args: shell.args,
      });
    },
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
            <Row styles={styles} label="Memory">
              {formatMiB(data.memoryMiB)}
            </Row>
            <Row styles={styles} label="Isolation key">
              <Text style={styles.mono}>{data.key}</Text>
            </Row>
          </Card>
        ) : null}
        <View style={styles.actions}>
          <Button
            styles={styles}
            label="Open shell in sandbox"
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
                label="Remove"
                confirmLabel="Confirm remove"
                disabled={action.isPending}
                onConfirm={() => action.mutate({ name: data.name, action: "remove" })}
              />
            </>
          ) : null}
        </View>
        {openShell.isPending ? <Text style={styles.muted}>Preparing the sandbox…</Text> : null}
        {openShell.error ? <Text style={styles.error}>{errorMessage(openShell.error)}</Text> : null}
        {action.error ? <Text style={styles.error}>{errorMessage(action.error)}</Text> : null}
      </Section>

      {data ? <MemoryOverride sandboxKey={data.key} overrideGiB={data.overrideMemoryGiB} styles={styles} /> : null}

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
    </Screen>
  );
}

function MemoryOverride({
  sandboxKey,
  overrideGiB,
  styles,
}: {
  sandboxKey: string;
  overrideGiB: number | null;
  styles: ReturnType<typeof useStyles>;
}) {
  const settings = useSettings(sandboxSettings);
  const invalidate = useInvalidateAll();
  const [draft, setDraft] = useState(overrideGiB === null ? "" : String(overrideGiB));
  if (settings.status !== "ready") return null;

  const value = draft.trim() === "" ? null : Number(draft);
  const invalid = value !== null && !(Number.isFinite(value) && value > 0);

  async function save() {
    if (settings.status !== "ready" || invalid) return;
    const overrides = { ...settings.values.overrides };
    const current = overrides[sandboxKey] ?? { mounts: [], envNames: [] };
    overrides[sandboxKey] = { ...current, memoryGiB: value ?? undefined };
    await settings.save({ ...settings.values, overrides }, settings.revision);
    invalidate();
  }

  return (
    <Section styles={styles} title="Memory for this sandbox">
      <Card styles={styles}>
        <SettingsInput
          label="Memory (GiB)"
          hint="Empty uses the default. Applies when the sandbox is next created: remove it to recreate."
          initialValue={draft}
          placeholder="default"
          error={invalid ? "Enter a positive number" : settings.saveError}
          onChangeText={setDraft}
        />
      </Card>
      <View style={styles.actions}>
        <Button styles={styles} label="Save" primary disabled={invalid || settings.saving} onPress={() => void save()} />
      </View>
    </Section>
  );
}
