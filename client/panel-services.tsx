import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { publishPortRpc, unpublishPortRpc } from "../shared/rpc";
import { errorMessage, plural } from "./format";
import { Empty, Frame } from "./frame";
import { Actions, Button, Field, ListRow, Note, Pill, Section, SwitchRow, ago, useNow } from "./kit";
import type { PanelTabProps } from "./panel";
import { useAwaitOperation, useInvalidateAll, useRepoSettings } from "./queries";

const validPort = (value: number) => Number.isInteger(value) && value > 0 && value < 65536;

export function ServicesTab({ data, theme, compact, header }: PanelTabProps) {
  const now = useNow(5_000);
  const invalidate = useInvalidateAll();
  const publishRpc = useRpc(publishPortRpc);
  const unpublishRpc = useRpc(unpublishPortRpc);
  const awaitOperation = useAwaitOperation();
  const publish = useMutation({
    mutationFn: async (input: { guestPort: number; allInterfaces: boolean; hostPort: number | null }) =>
      awaitOperation(await publishRpc({ name: data.name, ...input })),
    onSettled: invalidate,
  });
  const unpublish = useMutation({
    mutationFn: async (guestPort: number) => awaitOperation(await unpublishRpc({ name: data.name, guestPort })),
    onSettled: invalidate,
  });
  const { repo, save } = useRepoSettings(data.repoKey);
  const [allInterfaces, setAllInterfaces] = useState(false);
  const [guestPort, setGuestPort] = useState("");
  const [hostPort, setHostPort] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  const { services } = data;
  const running = data.status === "running";
  const published = new Map(services.publications.map((publication) => [publication.guestPort, publication]));
  const parsedGuest = Number(guestPort);
  const parsedHost = hostPort.trim() === "" ? null : Number(hostPort);
  const hostInvalid = parsedHost !== null && !validPort(parsedHost);
  const guestInvalid = guestPort.trim() !== "" && !validPort(parsedGuest);
  const publishLabel = running ? "Publish" : "Publish and start the VM";

  function toggleAuto(port: number, enabled: boolean) {
    if (!repo) return;
    const autoPublish = enabled ? [...new Set([...repo.autoPublish, port])] : repo.autoPublish.filter((entry) => entry !== port);
    setRepoError(null);
    save({ autoPublish }).catch((error: unknown) => setRepoError(errorMessage(error)));
  }

  const frame = {
    theme,
    compact,
    title: "Services",
    description: "Ports listening in the VM, and the ones published on this host.",
    ...header,
    notes: [
      "The guest reports its listening ports while an agent or shell runs. Services that listen only on the VM's loopback can be published too.",
      "A published port keeps its host port across VM restarts. A port set to always publish is published in every sandbox of the repository at its next launch.",
      "When a fixed host port is taken as the VM starts, the port shows as not published: pick another, or leave it empty.",
    ],
  };
  if (!data.status) {
    return (
      <Frame {...frame}>
        <Empty
          theme={theme}
          title="No sandbox yet"
          detail="Services show up once the sandbox exists and something listens in it."
        />
      </Frame>
    );
  }

  return (
    <Frame {...frame}>
      <Section
        theme={theme}
        overline={
          services.snapshotAt === null
            ? "No report yet"
            : `${running ? "Reported" : "VM stopped · as of"} ${ago(services.snapshotAt * 1000, now)}`
        }
        title="Listening in the VM"
        gap={6}
      >
        {services.listeners.length === 0 ? (
          <Note theme={theme}>
            {services.snapshotAt === null
              ? "The next agent or shell starts reporting the VM's listening ports."
              : "Nothing listens in the VM."}
          </Note>
        ) : (
          <View role="list">
            {services.listeners.map((listener, index) => {
              const publication = published.get(listener.port);
              return (
                <ListRow
                  key={listener.port}
                  theme={theme}
                  first={index === 0}
                  stacked={compact}
                  title={`Port ${listener.port}`}
                  detail={`Listening on ${listener.addresses.join(", ")}`}
                  aside={
                    publication?.hostPort ? (
                      <Pill
                        theme={theme}
                        tone="success"
                        dot
                        label={`Published on ${publication.allInterfaces ? "0.0.0.0" : "127.0.0.1"}:${publication.hostPort}`}
                      />
                    ) : (
                      <Button
                        theme={theme}
                        small
                        label={publishLabel}
                        disabled={publish.isPending || hostInvalid}
                        onPress={() => publish.mutate({ guestPort: listener.port, allInterfaces, hostPort: parsedHost })}
                      />
                    )
                  }
                />
              );
            })}
          </View>
        )}
      </Section>

      <Section theme={theme} overline={plural(services.publications.length, "port")} title="Published on this host" gap={6}>
        {services.publications.length === 0 ? (
          <Note theme={theme}>No port is published. Publish one above, or by its number below.</Note>
        ) : (
          <View role="list">
            {services.publications.map((publication, index) => {
              const auto = repo?.autoPublish.includes(publication.guestPort) ?? false;
              return (
                <ListRow
                  key={publication.guestPort}
                  theme={theme}
                  first={index === 0}
                  stacked={compact}
                  title={
                    publication.hostPort === null
                      ? `Port ${publication.guestPort} · not published`
                      : `Port ${publication.guestPort} → ${publication.allInterfaces ? "0.0.0.0" : "127.0.0.1"}:${publication.hostPort}`
                  }
                  detail={
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                      {publication.hostPort === null ? <Pill theme={theme} tone="warning" dot label="Host port taken" /> : null}
                      {publication.allInterfaces ? (
                        <Pill theme={theme} tone="warning" label="Every host address" />
                      ) : (
                        <Pill theme={theme} label="This host only" />
                      )}
                      {auto ? <Pill theme={theme} tone="accent" label="Always published in this repository" /> : null}
                    </View>
                  }
                  aside={
                    <>
                      {repo ? (
                        <Button
                          theme={theme}
                          small
                          kind="quiet"
                          label={auto ? "Stop publishing always" : "Always publish"}
                          onPress={() => toggleAuto(publication.guestPort, !auto)}
                        />
                      ) : null}
                      <Button
                        theme={theme}
                        small
                        label="Unpublish"
                        busy={unpublish.isPending && unpublish.variables === publication.guestPort}
                        disabled={unpublish.isPending}
                        onPress={() => unpublish.mutate(publication.guestPort)}
                      />
                    </>
                  }
                />
              );
            })}
          </View>
        )}
      </Section>

      <Section theme={theme} title="Publish a port" overline="Before its service starts, or on a host port you choose">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          <Field
            theme={theme}
            label="Guest port"
            placeholder="5173"
            value={guestPort}
            onChangeText={setGuestPort}
            error={guestInvalid ? "Enter a port from 1 to 65535" : null}
          />
          <Field
            theme={theme}
            label="Host port"
            placeholder="Any free port"
            value={hostPort}
            onChangeText={setHostPort}
            hint="Also used by Publish above."
            error={hostInvalid ? "Enter a port from 1 to 65535" : null}
          />
        </View>
        <SwitchRow
          theme={theme}
          label="Listen on every host address"
          hint="Off publishes on 127.0.0.1 only. On, anyone who reaches this host can open the service, without authentication."
          value={allInterfaces}
          onValueChange={setAllInterfaces}
        />
        <Actions>
          <Button
            theme={theme}
            kind="primary"
            label={publishLabel}
            busy={publish.isPending}
            disabled={!validPort(parsedGuest) || hostInvalid}
            onPress={() => publish.mutate({ guestPort: parsedGuest, allInterfaces, hostPort: parsedHost })}
          />
        </Actions>
        {publish.error ? (
          <Note theme={theme} tone="danger">
            {errorMessage(publish.error)}
          </Note>
        ) : null}
        {unpublish.error ? (
          <Note theme={theme} tone="danger">
            {errorMessage(unpublish.error)}
          </Note>
        ) : null}
        {repoError ? (
          <Note theme={theme} tone="danger">
            {repoError}
          </Note>
        ) : null}
      </Section>
    </Frame>
  );
}
