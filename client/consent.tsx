import { useSettings } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { sandboxSettings } from "../shared/settings";
import { errorMessage } from "./format";
import { Actions, Button, Section, text, type Theme } from "./kit";

/**
 * Your consent to download sbx's agent kit images, asked before anything that can download one
 * runs: a catalog, or a sandbox or template preparation without a template. The server and the
 * wrapper refuse those without it too; this asks first, so nothing starts and fails.
 */
export function useDownloadConsent() {
  const settings = useSettings(sandboxSettings);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = settings.status === "ready" && settings.values.allowImageDownloads;

  async function save(allow: boolean): Promise<boolean> {
    if (settings.status !== "ready") return false;
    setSaving(true);
    setError(null);
    try {
      await settings.save({ ...settings.values, allowImageDownloads: allow }, settings.revision);
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setSaving(false);
    }
  }

  return {
    allowed,
    /** Settings are loaded, so `allowed` is known. */
    ready: settings.status === "ready",
    pending: pending !== null,
    saving,
    error,
    /** Runs the action now when downloads are allowed; otherwise asks first. */
    request(action: () => void, needsDownload = true) {
      if (allowed || !needsDownload) action();
      else setPending(() => action);
    },
    /** Records your consent, then runs what was waiting for it. */
    async allow() {
      if (!(await save(true))) return;
      const action = pending;
      setPending(null);
      action?.();
    },
    cancel() {
      setPending(null);
      setError(null);
    },
  };
}

export type DownloadConsent = ReturnType<typeof useDownloadConsent>;

export const DOWNLOAD_TERMS =
  "Sandboxes and agent catalogs start from sbx's kit images, downloaded from Docker Hub (docker/sandbox-templates) the first time one is needed: about 1.1 GB for Claude and 1.3 GB for Codex. Sandboxes created from your templates use the local image.";

/**
 * The question, shown where an action waits for consent; nothing is downloaded until you allow it.
 * `standing` keeps it up while downloads are not allowed, without an action waiting.
 */
export function DownloadConsentPrompt({
  consent,
  theme,
  standing = false,
}: {
  consent: DownloadConsent;
  theme: Theme;
  standing?: boolean;
}) {
  if (!consent.pending && !(standing && consent.ready && !consent.allowed)) return null;
  return (
    <Section theme={theme} tone="warning" padding={16} gap={10}>
      <View style={{ gap: 4 }}>
        <Text role="heading" style={text(theme, 14, "600")}>
          {consent.pending ? "Allow downloading sbx images?" : "Downloading sbx images is not allowed"}
        </Text>
        <Text style={text(theme, 13, "400", true)}>{`${DOWNLOAD_TERMS} You can turn it off again in the plugin settings.`}</Text>
      </View>
      <Actions>
        <Button
          theme={theme}
          kind="primary"
          small
          label="Allow downloads"
          busy={consent.saving}
          onPress={() => void consent.allow()}
        />
        {consent.pending ? (
          <Button theme={theme} kind="quiet" small label="Not now" disabled={consent.saving} onPress={consent.cancel} />
        ) : null}
      </Actions>
      {consent.error ? <Text style={{ ...text(theme, 12), color: theme.colors.statusDanger }}>{consent.error}</Text> : null}
    </Section>
  );
}
