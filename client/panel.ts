import type { ReactNode } from "react";
import { homeOf, operationLabel, plural, shortRef, tildify } from "./format";
import type { Theme, Tone } from "./kit";
import type { Description } from "./queries";

/** What the workspace panel's tabs share, and what it reads off a sandbox's description. */

export type PanelTab = "overview" | "services" | "template" | "resources" | "mounts" | "variables";

export interface PanelTabProps {
  data: Description;
  workspaceId: string;
  directory: string;
  theme: Theme;
  compact: boolean;
  /** The sandbox's status and the refresh control, shown in every tab's header. */
  header: { status: ReactNode; actions: ReactNode };
  go(tab: PanelTab): void;
}

/** One thing in the sandbox that waits on you, and the tab where you fix it. */
export interface PanelNeed {
  tone: Tone;
  title: string;
  detail: string | null;
  tab: PanelTab | null;
}

const templateLabel = (ref: string | null) => (ref ? shortRef(ref) : "the sbx image");

/** Mounts configured after the sandbox was created, and mounts it has that are no longer configured. */
export function pendingMounts(data: Description): { added: string[]; removed: string[] } {
  return {
    added: data.mounts.filter((mount) => mount.exists && mount.applied === false).map((mount) => mount.path),
    removed: data.removedMounts,
  };
}

/** Failed operations first, then what the sandbox lacks against the repository's settings. */
export function panelNeeds(data: Description): PanelNeed[] {
  const needs: PanelNeed[] = [];
  const home = homeOf(data.workspace);
  const short = (path: string) => tildify(path, home);
  for (const operation of data.operations.filter((entry) => entry.status === "failed")) {
    needs.push({
      tone: "danger",
      title: `${operationLabel(operation.kind)} failed`,
      detail: operation.error,
      tab: operation.kind.includes("template") ? "template" : null,
    });
  }
  if (data.template.status === "diverged") {
    needs.push({
      tone: "warning",
      title: "The repository's template changed",
      detail: `This sandbox runs ${templateLabel(data.template.sandbox)}; new ones start from ${templateLabel(data.template.configured)}. Recreate it to apply.`,
      tab: "template",
    });
  }
  if (data.resourcesApplied === false) {
    needs.push({
      tone: "warning",
      title: "Memory or CPUs changed since the sandbox was created",
      detail: "Recreate it to apply them.",
      tab: "resources",
    });
  }
  const pending = pendingMounts(data);
  const changes = pending.added.length + pending.removed.length;
  if (data.status !== null && changes > 0) {
    needs.push({
      tone: "warning",
      title: `${plural(changes, "mount change")} ${changes === 1 ? "waits" : "wait"} for a recreation`,
      detail: [...pending.added.map((path) => `+ ${short(path)}`), ...pending.removed.map((path) => `− ${short(path)}`)].join(
        "   ",
      ),
      tab: "mounts",
    });
  }
  const missingMembers = data.gsdPath?.members.filter((member) => !member.available) ?? [];
  if (missingMembers.length > 0) {
    needs.push({
      tone: "warning",
      title: `GSD Path ${missingMembers.length === 1 ? "member" : "members"} without a checkout`,
      detail: missingMembers.map((member) => `${member.name} (${short(member.path)})`).join(", "),
      tab: "mounts",
    });
  }
  const missingMounts = data.mounts.filter((mount) => !mount.exists && mount.source !== "member");
  if (missingMounts.length > 0) {
    needs.push({
      tone: "warning",
      title: `${plural(missingMounts.length, "mount")} missing on the host`,
      detail: `${missingMounts.map((mount) => short(mount.path)).join(", ")}: sbx skips ${missingMounts.length === 1 ? "it" : "them"}.`,
      tab: "mounts",
    });
  }
  const missingEnv = data.env.filter((entry) => !entry.present && !entry.reserved);
  if (missingEnv.length > 0) {
    needs.push({
      tone: "warning",
      title: `${plural(missingEnv.length, "variable")} without a value`,
      detail: missingEnv.map((entry) => entry.name).join(", "),
      tab: "variables",
    });
  }
  if (data.status === "running") {
    const unpublished = data.services.publications.filter((publication) => publication.hostPort === null);
    if (unpublished.length > 0) {
      needs.push({
        tone: "warning",
        title: `${unpublished.length === 1 ? "A port is" : `${unpublished.length} ports are`} not published`,
        detail: `Guest ${unpublished.length === 1 ? "port" : "ports"} ${unpublished.map((publication) => publication.guestPort).join(", ")}: the host port was taken. Publish again to pick another.`,
        tab: "services",
      });
    }
  }
  return needs;
}

export type TabBadge = { label: string; tone?: Tone } | null;

/** The figure beside each tab's label, toned when the tab needs you. */
export function panelBadges(data: Description): Record<PanelTab, TabBadge> {
  const pending = pendingMounts(data);
  const mountChanges = data.status === null ? 0 : pending.added.length + pending.removed.length;
  const mountProblems = data.mounts.filter((mount) => !mount.exists).length;
  const missingEnv = data.env.filter((entry) => !entry.present && !entry.reserved).length;
  const unpublished =
    data.status === "running" ? data.services.publications.filter((publication) => publication.hostPort === null).length : 0;
  const needs = panelNeeds(data).length;
  return {
    overview:
      needs > 0
        ? { label: String(needs), tone: data.operations.some((entry) => entry.status === "failed") ? "danger" : "warning" }
        : null,
    services:
      unpublished > 0
        ? { label: String(unpublished), tone: "warning" }
        : data.services.listeners.length > 0
          ? { label: String(data.services.listeners.length) }
          : null,
    template: data.template.status === "diverged" ? { label: "Changed", tone: "warning" } : null,
    resources: data.resourcesApplied === false ? { label: "Changed", tone: "warning" } : null,
    mounts:
      mountChanges + mountProblems > 0
        ? { label: String(mountChanges + mountProblems), tone: "warning" }
        : { label: String(data.mounts.length + 1) },
    variables:
      missingEnv > 0
        ? { label: `${missingEnv} missing`, tone: "warning" }
        : data.env.length > 0
          ? { label: String(data.env.length) }
          : null,
  };
}
