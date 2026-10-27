import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DOCKER_ICON } from "./client/docker-icon";
import { SandboxesScreen } from "./client/sandboxes-screen";
import { SettingsScreen } from "./client/settings-screen";
import { WorkspacePanel } from "./client/workspace-panel";

function SandboxesItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon={DOCKER_ICON}
      active={currentScreen?.screenId === "sandboxes"}
      onPress={() => openScreen({ screenId: "sandboxes" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  function Screen(props: PluginScreenProps) {
    return <SandboxesScreen {...props} openSettings={() => client.openSettings("defaults")} />;
  }
  client.addScreen({ id: "sandboxes", title: "Docker Sandboxes", Component: Screen });
  client.addSidebarHeaderItem({ id: "sandboxes", title: "Docker Sandboxes", Component: SandboxesItem });
  client.addWorkspacePanel({ id: "sandbox", title: "Sandbox", icon: DOCKER_ICON, context: "workspace", Component: WorkspacePanel });
  client.addSettingsScreen({ id: "defaults", title: "Docker Sandboxes", icon: DOCKER_ICON, Component: SettingsScreen });
  return () => {};
}
