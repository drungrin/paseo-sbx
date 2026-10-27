import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { MountSource } from "../shared/spec";
import { invalidEnvNames, invalidMounts } from "../shared/spec";
import { errorMessage, formatMiB, homeOf, plural, tildify } from "./format";
import { Figures, Frame } from "./frame";
import {
  Actions,
  Button,
  ConfirmButton,
  Field,
  ListRow,
  Note,
  Pill,
  Section,
  Stat,
  mono,
  text,
  tint,
  toneColor,
  type Theme,
} from "./kit";
import { pendingMounts, type PanelTabProps } from "./panel";
import { useRepoSettings, useSandboxAction, useStatus, type Description } from "./queries";

/** Offers Recreate where a change waits for it, or says what keeps it from running. */
function RecreateCallout({
  data,
  theme,
  title,
  detail,
}: {
  data: Description;
  theme: Theme;
  title: string;
  detail?: string | null;
}) {
  const action = useSandboxAction();
  const blocked = data.recreateBlockers.length > 0;
  return (
    <Section theme={theme} tone="warning" padding={16} gap={10}>
      <View style={{ gap: 2 }}>
        <Text style={text(theme, 14, "600")}>{title}</Text>
        {detail ? <Text style={text(theme, 13, "400", true)}>{detail}</Text> : null}
      </View>
      <Actions>
        <ConfirmButton
          theme={theme}
          small
          label="Recreate the sandbox"
          confirmLabel="Confirm recreate"
          busy={action.isPending}
          disabled={blocked}
          onConfirm={() => action.mutate({ name: data.name, action: "recreate" })}
        />
        {blocked ? <Note theme={theme}>{`First: ${data.recreateBlockers.join("; ")}.`}</Note> : null}
      </Actions>
      {action.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(action.error)}
        </Note>
      ) : null}
    </Section>
  );
}

export function ResourcesTab({ data, theme, compact, header }: PanelTabProps) {
  const { repo, save, settings } = useRepoSettings(data.repoKey);
  const status = useStatus();
  const hostCpus = status.data?.hostCpus ?? null;
  const defaults = settings.status === "ready" ? settings.values : null;
  return (
    <Frame
      theme={theme}
      compact={compact}
      title="Resources"
      description="Memory and CPUs for this repository's sandboxes."
      {...header}
      notes={[
        "Builds start a process per CPU: with little memory, fewer CPUs keep them from running out of it.",
        "The VM takes host memory as it needs it, up to the limit. The Docker Sandboxes screen alerts when the host runs short.",
        "The Docker disk is set for every repository in the plugin settings.",
      ]}
    >
      {data.resourcesApplied === false ? (
        <RecreateCallout
          data={data}
          theme={theme}
          title="The sandbox was created with other resources"
          detail="Recreate it to apply the ones below."
        />
      ) : null}
      <Figures>
        <Stat
          theme={theme}
          label="Memory limit"
          value={formatMiB(data.memoryMiB)}
          detail={data.repoMemoryGiB === null ? "Default" : "Set for this repository"}
        />
        <Stat
          theme={theme}
          label="CPUs"
          value={data.cpus === 0 ? (hostCpus === null ? "All" : String(hostCpus)) : String(data.cpus)}
          detail={`${data.repoCpus === null ? "Default" : "Set for this repository"}${hostCpus === null ? "" : ` · ${hostCpus} on this host`}`}
        />
        <Stat
          theme={theme}
          label="In use now"
          value={data.rssMiB === null ? "—" : formatMiB(data.rssMiB)}
          detail={
            data.rssMiB === null
              ? data.status
                ? "The VM is stopped"
                : "No sandbox yet"
              : `${Math.round((100 * data.rssMiB) / data.memoryMiB)}% of the limit`
          }
        />
      </Figures>
      {repo && defaults && status.data ? (
        // Keyed so a different repo or a saved value starts from a fresh draft.
        <ResourcesForm
          key={`${data.repoKey}:${data.repoMemoryGiB ?? ""}:${data.repoCpus ?? ""}`}
          data={data}
          theme={theme}
          hostMemoryMiB={status.data.hostMemoryMiB}
          defaultMemoryMiB={status.data.defaultMemoryMiB}
          hostCpus={status.data.hostCpus}
          defaultCpus={defaults.cpus}
          saving={settings.status === "ready" && settings.saving}
          onSave={(patch) => save(patch)}
        />
      ) : null}
    </Frame>
  );
}

function ResourcesForm({
  data,
  theme,
  hostMemoryMiB,
  defaultMemoryMiB,
  hostCpus,
  defaultCpus,
  saving,
  onSave,
}: {
  data: Description;
  theme: Theme;
  hostMemoryMiB: number;
  defaultMemoryMiB: number;
  hostCpus: number;
  defaultCpus: number;
  saving: boolean;
  onSave(patch: { memoryGiB?: number; cpus?: number }): Promise<void>;
}) {
  const [memoryDraft, setMemoryDraft] = useState(data.repoMemoryGiB === null ? "" : String(data.repoMemoryGiB));
  const [cpusDraft, setCpusDraft] = useState(data.repoCpus === null ? "" : String(data.repoCpus));
  const [error, setError] = useState<string | null>(null);
  const maxGiB = Math.floor((hostMemoryMiB * 0.75) / 102.4) / 10;
  const memory = memoryDraft.trim() === "" ? null : Number(memoryDraft);
  const memoryInvalid = memory !== null && !(Number.isFinite(memory) && memory >= 0.5 && memory <= maxGiB);
  const cpus = cpusDraft.trim() === "" ? null : Number(cpusDraft);
  const cpusInvalid = cpus !== null && !(Number.isInteger(cpus) && cpus >= 0 && cpus <= hostCpus);
  const changed = memory !== data.repoMemoryGiB || cpus !== data.repoCpus;
  return (
    <Section theme={theme} overline="Every worktree of the repository" title="For this repository">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        <Field
          theme={theme}
          label="Memory (GiB)"
          placeholder={`Default · ${formatMiB(defaultMemoryMiB)}`}
          value={memoryDraft}
          onChangeText={setMemoryDraft}
          hint={`From 0.5 to ${maxGiB}. Empty uses the default.`}
          error={memoryInvalid ? `Enter a number from 0.5 to ${maxGiB}` : null}
        />
        <Field
          theme={theme}
          label="CPUs"
          placeholder={`Default · ${defaultCpus === 0 ? `all ${hostCpus}` : defaultCpus}`}
          value={cpusDraft}
          onChangeText={setCpusDraft}
          hint="0 is every CPU. Empty uses the default."
          error={cpusInvalid ? `Enter a whole number from 0 to ${hostCpus}` : null}
        />
      </View>
      <Actions>
        <Button
          theme={theme}
          kind="primary"
          label="Save"
          busy={saving}
          disabled={memoryInvalid || cpusInvalid || !changed}
          onPress={() => {
            setError(null);
            onSave({ memoryGiB: memory ?? undefined, cpus: cpus ?? undefined }).catch((caught: unknown) =>
              setError(errorMessage(caught)),
            );
          }}
        />
        <Note theme={theme}>Sandboxes get them when created: recreate to apply a change.</Note>
      </Actions>
      {error ? (
        <Note theme={theme} tone="danger">
          {error}
        </Note>
      ) : null}
    </Section>
  );
}

const MOUNT_SOURCE_LABELS: Record<MountSource, string> = {
  settings: "All repositories",
  repo: "This repository",
  "gsd-path": "GSD Path",
  member: "GSD Path member",
  git: "Git metadata",
  claude: "Shared Claude config",
  agents: "Agents' shared homes",
};

export function MountsTab({ data, theme, compact, header }: PanelTabProps) {
  const { repo, save, settings } = useRepoSettings(data.repoKey);
  const home = homeOf(data.workspace);
  const pending = pendingMounts(data);
  const changes = data.status === null ? 0 : pending.added.length + pending.removed.length;
  return (
    <Frame
      theme={theme}
      compact={compact}
      title="Mounts"
      description="Host folders the sandbox sees, at the same paths."
      {...header}
      notes={[
        "Paths under your home also appear under the agent's home, so tools find their config where they expect it.",
        "Mounts for every repository are in the plugin settings. Share tool state and credentials here; install tools in a template instead.",
        "A path missing on the host is skipped when the sandbox is created.",
      ]}
    >
      {changes > 0 ? (
        <RecreateCallout
          data={data}
          theme={theme}
          title={`${plural(changes, "mount change")} ${changes === 1 ? "waits" : "wait"} for a recreation`}
          detail={[
            ...pending.added.map((path) => `+ ${tildify(path, home)}`),
            ...pending.removed.map((path) => `− ${tildify(path, home)}`),
          ].join("   ")}
        />
      ) : null}
      <Section
        theme={theme}
        overline={plural(data.mounts.length + 1, "mount")}
        title={data.status ? "In this sandbox" : "For the new sandbox"}
        gap={4}
      >
        <View role="list">
          <ListRow
            theme={theme}
            first
            monospace
            stacked={compact}
            title={tildify(data.workspace, home)}
            detail="Workspace"
            aside={<Pill theme={theme} label="Writable" />}
          />
          {data.mounts.map((mount) => (
            <ListRow
              key={`${mount.source}:${mount.path}`}
              theme={theme}
              monospace
              stacked={compact}
              title={tildify(mount.path, home)}
              detail={MOUNT_SOURCE_LABELS[mount.source]}
              aside={
                <>
                  {!mount.exists ? (
                    <Pill theme={theme} tone="danger" dot label="Missing on the host" />
                  ) : mount.applied === false ? (
                    <Pill theme={theme} tone="warning" dot label="After a recreation" />
                  ) : null}
                  <Pill theme={theme} label={mount.readOnly ? "Read-only" : "Writable"} />
                </>
              }
            />
          ))}
          {data.removedMounts.map((path) => (
            <ListRow
              key={`removed:${path}`}
              theme={theme}
              monospace
              stacked={compact}
              title={tildify(path, home)}
              detail="No longer configured"
              aside={<Pill theme={theme} tone="warning" dot label="Leaves at a recreation" />}
            />
          ))}
        </View>
      </Section>
      {repo && settings.status === "ready" ? (
        <Section theme={theme} overline="Every worktree of the repository" title="Mounts for this repository">
          <ItemsEditor
            key={repo.mounts.join("\n")}
            theme={theme}
            items={repo.mounts}
            label="Add a mount"
            placeholder="~/.config/gh"
            option={{ label: "Read-only", suffix: ":ro" }}
            describe={(item) =>
              item.endsWith(":ro") ? { title: item.slice(0, -3), pill: "Read-only" } : { title: item, pill: "Writable" }
            }
            validate={(item) => (invalidMounts([item]).length > 0 ? "Use an absolute or ~/ path" : null)}
            empty="No mounts of its own. The ones above come from the plugin settings and the workspace."
            onSave={(mounts) => save({ mounts })}
          />
        </Section>
      ) : null}
      {data.gsdPath ? <GsdPath gsdPath={data.gsdPath} theme={theme} compact={compact} home={home} /> : null}
    </Frame>
  );
}

function GsdPath({
  gsdPath,
  theme,
  compact,
  home,
}: {
  gsdPath: NonNullable<Description["gsdPath"]>;
  theme: Theme;
  compact: boolean;
  home: string | null;
}) {
  return (
    <Section
      theme={theme}
      overline=".project/MEMBERS.md"
      title="GSD Path members"
      aside={
        <Pill
          theme={theme}
          tone={gsdPath.enabled ? "success" : "neutral"}
          dot
          label={gsdPath.enabled ? "Mounted" : "Off in the settings"}
        />
      }
      gap={4}
    >
      {gsdPath.members.length === 0 ? (
        <Note theme={theme}>MEMBERS.md lists no members.</Note>
      ) : (
        <View role="list">
          {gsdPath.members.map((member, index) => (
            <ListRow
              key={member.name}
              theme={theme}
              first={index === 0}
              stacked={compact}
              title={member.name}
              detail={<Text style={mono(theme, 12, true)}>{tildify(member.path, home)}</Text>}
              aside={
                member.available ? (
                  <Pill theme={theme} label="Writable" />
                ) : (
                  <Pill theme={theme} tone="danger" dot label="No checkout on the host" />
                )
              }
            />
          ))}
        </View>
      )}
      <Note theme={theme}>
        {gsdPath.enabled
          ? "The sandbox mounts ~/.gsd-path, also in the agent's home, and the member checkouts. New worktrees go under your ~/.gsd-path/projects."
          : "Turn on Mount GSD Path in the plugin settings to give the sandbox ~/.gsd-path and the member checkouts."}
      </Note>
    </Section>
  );
}

export function VariablesTab({ data, theme, compact, header }: PanelTabProps) {
  const { repo, save, settings } = useRepoSettings(data.repoKey);
  const status = useStatus();
  const envFile = status.data?.envFile ?? "the variables file";
  const missing = data.env.filter((entry) => !entry.present && !entry.reserved).length;
  return (
    <Frame
      theme={theme}
      compact={compact}
      title="Variables"
      description="Host variables forwarded to the agents' sessions."
      {...header}
      notes={[
        `Values come from ${envFile}, then the daemon environment: the daemon does not load your shell profile.`,
        "Variables for every repository are in the plugin settings. Sessions started after a change get it; no recreation needed.",
        "Names the host's sbx client reads itself (PATH, HOME, XDG_*, SBX_*, DOCKER_*) are never forwarded.",
      ]}
    >
      <Section
        theme={theme}
        overline={
          missing > 0
            ? `${plural(data.env.length, "variable")} · ${missing} without a value`
            : plural(data.env.length, "variable")
        }
        title="Forwarded to sessions"
        gap={4}
      >
        {data.env.length === 0 ? (
          <Note theme={theme}>No variables are forwarded.</Note>
        ) : (
          <View role="list">
            {data.env.map((entry, index) => (
              <ListRow
                key={entry.name}
                theme={theme}
                first={index === 0}
                monospace
                stacked={compact}
                title={entry.name}
                detail={entry.scope === "all" ? "All repositories" : "This repository"}
                aside={
                  entry.reserved ? (
                    <Pill theme={theme} label="Kept by sbx" />
                  ) : entry.present ? (
                    <Pill theme={theme} tone="success" dot label="Set" />
                  ) : (
                    <Pill theme={theme} tone="warning" dot label="No value" />
                  )
                }
              />
            ))}
          </View>
        )}
        {missing > 0 ? <Note theme={theme}>{`Add the missing values to ${envFile}.`}</Note> : null}
      </Section>
      {repo && settings.status === "ready" ? (
        <Section theme={theme} overline="Every worktree of the repository" title="Variables for this repository">
          <ItemsEditor
            key={repo.envNames.join("\n")}
            theme={theme}
            items={repo.envNames}
            label="Add a variable"
            placeholder="MY_LICENSE_KEY"
            describe={(item) => ({ title: item })}
            validate={(item) => (invalidEnvNames([item]).length > 0 ? "Not a variable you can forward" : null)}
            empty="No variables of its own."
            onSave={(envNames) => save({ envNames })}
          />
        </Section>
      ) : null}
    </Frame>
  );
}

/** A list setting edited an item at a time; every change saves. */
function ItemsEditor({
  theme,
  items,
  label,
  placeholder,
  option,
  describe,
  validate,
  empty,
  onSave,
}: {
  theme: Theme;
  items: readonly string[];
  label: string;
  placeholder: string;
  /** A flag an item carries as a suffix, such as `:ro`. */
  option?: { label: string; suffix: string };
  describe(item: string): { title: string; pill?: string };
  validate(item: string): string | null;
  empty: string;
  onSave(items: string[]): Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [flag, setFlag] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entry = draft.trim() + (flag && option && !draft.trim().endsWith(option.suffix) ? option.suffix : "");
  const invalid = draft.trim() === "" ? null : (validate(entry) ?? (items.includes(entry) ? "Already in the list" : null));
  const accent = toneColor(theme, "accent");

  function commit(next: string[]) {
    setSaving(true);
    setError(null);
    onSave(next)
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => setSaving(false));
  }

  return (
    <View style={{ gap: 12 }}>
      {items.length === 0 ? (
        <Note theme={theme}>{empty}</Note>
      ) : (
        <View role="list" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {items.map((item) => {
            const view = describe(item);
            return (
              <View
                key={item}
                role="listitem"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingLeft: 12,
                  paddingRight: 4,
                  minHeight: 34,
                  borderRadius: 10,
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <Text selectable style={mono(theme, 12)}>
                  {view.title}
                </Text>
                {view.pill ? <Text style={text(theme, 11, "500", true)}>{view.pill}</Text> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${item}`}
                  disabled={saving}
                  onPress={() => commit(items.filter((other) => other !== item))}
                  style={(state) => ({
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: (state as { hovered?: boolean }).hovered
                      ? tint(theme, toneColor(theme, "danger"), 0.18)
                      : "transparent",
                  })}
                >
                  <Text style={text(theme, 14, "600", true)}>×</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 10 }}>
        <Field
          theme={theme}
          monospace
          label={label}
          placeholder={placeholder}
          value={draft}
          onChangeText={setDraft}
          error={invalid}
          onSubmit={() => {
            if (draft.trim() && !invalid) commit([...items, entry]);
          }}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 24 }}>
          {option ? (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: flag }}
              onPress={() => setFlag(!flag)}
              style={{
                minHeight: 36,
                justifyContent: "center",
                paddingHorizontal: 12,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: flag ? accent : "transparent",
                backgroundColor: flag ? tint(theme, accent, 0.14) : theme.colors.surface2,
              }}
            >
              <Text style={text(theme, 13, flag ? "600" : "400", !flag)}>{`${flag ? "✓ " : ""}${option.label}`}</Text>
            </Pressable>
          ) : null}
          <Button
            theme={theme}
            kind="primary"
            label="Add"
            busy={saving}
            disabled={draft.trim() === "" || invalid !== null}
            onPress={() => commit([...items, entry])}
          />
        </View>
      </View>
      {error ? (
        <Note theme={theme} tone="danger">
          {error}
        </Note>
      ) : null}
    </View>
  );
}
