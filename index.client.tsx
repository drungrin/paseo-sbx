import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SandboxesScreen } from "./client/sandboxes-screen";
import { SettingsScreen } from "./client/settings-screen";
import { WorkspacePanel } from "./client/workspace-panel";

function SandboxesItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Box"
      active={currentScreen?.screenId === "sandboxes"}
      onPress={() => openScreen({ screenId: "sandboxes" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  function Screen(props: PluginScreenProps) {
    return <SandboxesScreen {...props} openSettings={() => client.openSettings("defaults")} />;
  }
  client.addScreen({ id: "sandboxes", title: "Sandboxes", Component: Screen });
  client.addSidebarHeaderItem({ id: "sandboxes", title: "Sandboxes", Component: SandboxesItem });
  client.addWorkspacePanel({ id: "sandbox", title: "Sandbox", icon: "Box", context: "workspace", Component: WorkspacePanel });
  client.addSettingsScreen({ id: "defaults", title: "Sandboxes", icon: "Box", Component: SettingsScreen });
  return () => {};
}
