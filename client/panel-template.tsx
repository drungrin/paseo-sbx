import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { finishTemplateRpc, prepareTemplateRpc, refResultSchema, shellResultSchema } from "../shared/rpc";
import { TEMPLATE_TAG_PATTERN } from "../shared/spec";
import { errorMessage, formatBytes, plural, shortRef } from "./format";
import { Frame } from "./frame";
import {
  Actions,
  Button,
  Choice,
  ConfirmButton,
  Field,
  Note,
  Pill,
  Section,
  SwitchRow,
  kicker,
  mono,
  text,
  tint,
  toneColor,
  type Theme,
} from "./kit";
import type { PanelTabProps } from "./panel";
import {
  useAwaitOperation,
  useInvalidateAll,
  useOpenTerminal,
  useRemoveTemplate,
  useRepoSettings,
  useSandboxAction,
  useSaveTemplate,
  useTemplates,
} from "./queries";

function defaultTag(repoName: string): string {
  const slug =
    repoName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "template";
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${slug}:${stamp}`;
}

type TemplateSummary = NonNullable<ReturnType<typeof useTemplates>["data"]>["templates"][number];

/** What keeps a template: settings that pick it, and sandboxes created from it. */
function usage(template: TemplateSummary, data: PanelTabProps["data"]): string {
  const otherRepos = template.users.filter((user) => user !== "default" && user !== data.repoKey).length;
  const otherSandboxes = template.sandboxes.filter((name) => name !== data.name).length;
  const parts = [
    template.users.includes(data.repoKey) ? "used by this repository" : null,
    template.users.includes("default") ? "the default" : null,
    otherRepos > 0 ? `used by ${plural(otherRepos, "other repository", "other repositories")}` : null,
    template.sandboxes.includes(data.name) ? "this sandbox runs it" : null,
    otherSandboxes > 0
      ? `${plural(otherSandboxes, "other sandbox", "other sandboxes")} ${otherSandboxes === 1 ? "runs" : "run"} it`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "unused";
}

/** Nothing picks it and no sandbox runs it: the server removes only those. */
const removable = (template: TemplateSummary) => template.users.length === 0 && template.sandboxes.length === 0;

export function TemplateTab({ data, theme, compact, header, workspaceId, directory }: PanelTabProps) {
  const templates = useTemplates();
  const remove = useRemoveTemplate();
  const { repo, save, settings } = useRepoSettings(data.repoKey);
  const [selectError, setSelectError] = useState<string | null>(null);
  const globalTemplate = settings.status === "ready" ? settings.values.template : "";
  const custom = (templates.data?.templates ?? []).filter((template) => !template.base);
  const choices: { value: string; title: string; detail: string; removable: boolean }[] = [
    {
      value: "",
      title: globalTemplate ? `Default · ${shortRef(globalTemplate)}` : "Default · sbx image",
      detail: "What the plugin settings pick for every repository",
      removable: false,
    },
    ...custom.map((template) => ({
      value: template.ref,
      title: shortRef(template.ref),
      detail: [formatBytes(template.sizeBytes), usage(template, data)].join(" · "),
      removable: removable(template),
    })),
  ];
  if (repo?.template && !choices.some((choice) => choice.value === repo.template)) {
    choices.push({
      value: repo.template,
      title: shortRef(repo.template),
      detail: "Missing: sbx no longer has it",
      removable: false,
    });
  }
  const keptBySandbox = custom.some((template) => template.users.length === 0 && template.sandboxes.length > 0);

  return (
    <Frame
      theme={theme}
      compact={compact}
      title="Template"
      description="What new sandboxes of this repository start from."
      {...header}
      notes={[
        "A template is a saved VM filesystem: the tools and CLIs your agents need. It carries the CLIs of the agents it was prepared with, so a workspace running Claude and Codex needs a template with both.",
        "Templates do not include the images of the VM's own Docker: each new sandbox pulls them again.",
        "Every worktree of the repository shares its template.",
        "Remove appears on templates nothing uses: no setting picks them and no sandbox was created from them.",
      ]}
    >
      <Section theme={theme} overline="Every worktree of the repository" title="Template for this repository">
        {data.status ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <Text style={kicker(theme)}>This sandbox runs</Text>
            <Text style={mono(theme, 12)}>
              {data.template.sandbox
                ? shortRef(data.template.sandbox)
                : data.template.status === "unknown"
                  ? "an unrecorded template"
                  : "the sbx image"}
            </Text>
            {data.template.status === "diverged" ? (
              <Pill theme={theme} tone="warning" dot label="Recreate to switch" />
            ) : data.template.status === "match" ? (
              <Pill theme={theme} tone="success" dot label="Current" />
            ) : null}
          </View>
        ) : null}
        {repo ? (
          <View role="radiogroup" accessibilityLabel="Template for this repository" style={{ gap: 6 }}>
            {choices.map((choice) => (
              <Choice
                key={choice.value || "default"}
                theme={theme}
                title={choice.title}
                detail={choice.detail}
                selected={repo.template === choice.value}
                action={
                  choice.removable ? (
                    <ConfirmButton
                      theme={theme}
                      small
                      label="Remove"
                      confirmLabel="Confirm remove"
                      busy={remove.isPending && remove.variables === choice.value}
                      disabled={remove.isPending}
                      onConfirm={() => remove.mutate(choice.value)}
                    />
                  ) : null
                }
                onPress={() => {
                  if (repo.template === choice.value) return;
                  setSelectError(null);
                  save({ template: choice.value }).catch((error: unknown) => setSelectError(errorMessage(error)));
                }}
              />
            ))}
          </View>
        ) : null}
        {keptBySandbox ? (
          <Note theme={theme}>
            A template a sandbox was created from can be removed once that sandbox is recreated or removed.
          </Note>
        ) : null}
        {templates.error ? (
          <Note theme={theme} tone="danger">
            {errorMessage(templates.error)}
          </Note>
        ) : null}
        {remove.error ? (
          <Note theme={theme} tone="danger">
            {errorMessage(remove.error)}
          </Note>
        ) : null}
        {selectError ? (
          <Note theme={theme} tone="danger">
            {selectError}
          </Note>
        ) : null}
      </Section>

      <Prepare
        data={data}
        theme={theme}
        workspaceId={workspaceId}
        directory={directory}
        onSaved={(ref) => save({ template: ref })}
      />
      {data.status ? <SaveSandbox data={data} theme={theme} onSaved={(ref) => save({ template: ref })} /> : null}
    </Frame>
  );
}

function Steps({ theme, current }: { theme: Theme; current: number }) {
  const steps = ["Open a clean shell", "Install your tools", "Save as a template"];
  const accent = toneColor(theme, "accent");
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <View key={step} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: done || active ? accent : "transparent",
                borderWidth: done || active ? 0 : 1.5,
                borderColor: tint(theme, theme.colors.foregroundMuted, 0.5),
              }}
            >
              <Text
                style={{
                  ...text(theme, 11, "700"),
                  color: done || active ? theme.colors.accentForeground : theme.colors.foregroundMuted,
                }}
              >
                {done ? "✓" : index + 1}
              </Text>
            </View>
            <Text style={text(theme, 13, active ? "600" : "400", !active)}>{step}</Text>
            {index < steps.length - 1 ? <Text style={text(theme, 13, "400", true)}>→</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

function Prepare({
  data,
  theme,
  workspaceId,
  directory,
  onSaved,
}: Pick<PanelTabProps, "data" | "theme" | "workspaceId" | "directory"> & { onSaved(ref: string): Promise<void> }) {
  const action = useSandboxAction();
  const invalidate = useInvalidateAll();
  const openTerminal = useOpenTerminal(workspaceId);
  const prepareRpc = useRpc(prepareTemplateRpc);
  const finishRpc = useRpc(finishTemplateRpc);
  const awaitOperation = useAwaitOperation();
  const prepare = useMutation({
    mutationFn: async () =>
      openTerminal(shellResultSchema.parse(await awaitOperation(await prepareRpc({ workspaceId, directory })))),
    onSettled: invalidate,
  });
  const finish = useMutation({
    mutationFn: async (input: { name: string; tag: string }) =>
      refResultSchema.parse(await awaitOperation(await finishRpc(input))),
    onSettled: invalidate,
  });
  const prep = data.templatePrep;
  return (
    <Section
      theme={theme}
      tone={prep ? "accent" : undefined}
      overline={prep ? "Preparation in progress" : "New template"}
      title="Prepare a template"
    >
      <Steps theme={theme} current={prep ? 1 : 0} />
      {prep ? (
        <>
          <Note theme={theme}>{`Preparation sandbox ${prep}: install your tools from its shell, then save it here.`}</Note>
          <Actions>
            <Button theme={theme} label="Open preparation shell" busy={prepare.isPending} onPress={() => prepare.mutate()} />
            <ConfirmButton
              theme={theme}
              label="Discard"
              confirmLabel="Confirm discard"
              disabled={action.isPending}
              onConfirm={() => action.mutate({ name: prep, action: "remove" })}
            />
          </Actions>
          <SaveForm
            theme={theme}
            repoName={data.repoName}
            pending={finish.isPending}
            error={finish.error}
            submitLabel="Save as template"
            onSubmit={async (tag, useForRepo) => {
              const { ref } = await finish.mutateAsync({ name: prep, tag });
              if (useForRepo) await onSaved(ref);
            }}
          />
        </>
      ) : (
        <>
          <Note theme={theme}>
            Opens a shell in a clean sandbox from the repository's template, without your variables or credentials. Install what
            your agents need, then save it.
          </Note>
          <Actions>
            <Button
              theme={theme}
              kind="primary"
              label="Prepare template"
              busy={prepare.isPending}
              onPress={() => prepare.mutate()}
            />
          </Actions>
        </>
      )}
      {prepare.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(prepare.error)}
        </Note>
      ) : null}
      {action.error ? (
        <Note theme={theme} tone="danger">
          {errorMessage(action.error)}
        </Note>
      ) : null}
    </Section>
  );
}

function SaveSandbox({ data, theme, onSaved }: Pick<PanelTabProps, "data" | "theme"> & { onSaved(ref: string): Promise<void> }) {
  const saveTemplate = useSaveTemplate();
  const [open, setOpen] = useState(false);
  return (
    <Section theme={theme} overline="From what this sandbox has now" title="Save this sandbox as a template">
      <Note theme={theme}>
        Saving stops this sandbox, and needs every agent in it archived. The template captures its whole filesystem, including
        /home/agent: shell history, caches and any login tokens stored there.
      </Note>
      {open ? (
        <SaveForm
          theme={theme}
          repoName={data.repoName}
          pending={saveTemplate.isPending}
          error={saveTemplate.error}
          submitLabel="Save this sandbox"
          onCancel={() => setOpen(false)}
          onSubmit={async (tag, useForRepo) => {
            const { ref } = await saveTemplate.mutateAsync({ name: data.name, tag });
            if (useForRepo) await onSaved(ref);
            setOpen(false);
          }}
        />
      ) : (
        <Actions>
          <Button
            theme={theme}
            label="Save as template…"
            disabled={data.recreateBlockers.length > 0}
            onPress={() => setOpen(true)}
          />
          {data.recreateBlockers.length > 0 ? <Note theme={theme}>Archive the sandbox's agents first.</Note> : null}
        </Actions>
      )}
    </Section>
  );
}

function SaveForm({
  theme,
  repoName,
  pending,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  theme: Theme;
  repoName: string;
  pending: boolean;
  error: unknown;
  submitLabel: string;
  onSubmit(tag: string, useForRepo: boolean): Promise<void>;
  onCancel?(): void;
}) {
  const [tag, setTag] = useState(() => defaultTag(repoName));
  const [useForRepo, setUseForRepo] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const invalid = !TEMPLATE_TAG_PATTERN.test(tag.trim());
  const shown = submitError ?? (error ? errorMessage(error) : null);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row" }}>
        <Field
          theme={theme}
          monospace
          label="Template tag"
          hint="name:tag, lowercase."
          value={tag}
          onChangeText={setTag}
          error={invalid ? "Use lowercase letters, digits, . _ - and an optional :tag" : null}
        />
      </View>
      <SwitchRow theme={theme} label="Use it for this repository" value={useForRepo} onValueChange={setUseForRepo} />
      <Actions>
        <Button
          theme={theme}
          kind="primary"
          label={submitLabel}
          busy={pending}
          disabled={invalid}
          onPress={() => {
            setSubmitError(null);
            onSubmit(tag.trim(), useForRepo).catch((caught: unknown) => setSubmitError(errorMessage(caught)));
          }}
        />
        {onCancel ? <Button theme={theme} kind="quiet" label="Cancel" disabled={pending} onPress={onCancel} /> : null}
      </Actions>
      {shown ? (
        <Note theme={theme} tone="danger">
          {shown}
        </Note>
      ) : null}
    </View>
  );
}
