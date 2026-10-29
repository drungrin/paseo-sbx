import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DOCKER_ICON } from "./client/docker-icon";
import { sandboxTerminalRpc } from "./shared/rpc";
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
  client.addWorkspacePanel({
    id: "sandbox",
    title: "Sandbox dashboard",
    icon: DOCKER_ICON,
    context: "workspace",
    Component: WorkspacePanel,
  });
  // The same shell as the Sandbox terminal profile in the + menu, which a plugin cannot add to.
  client.addCommandCenterItem({
    id: "sandbox-terminal",
    title: "Open sandbox terminal",
    icon: DOCKER_ICON,
    keywords: ["sbx", "docker", "shell", "terminal", "sandbox"],
    context: "workspace",
    async onSelect({ workspace, rpc, paseo }) {
      const shell = await rpc(sandboxTerminalRpc, { workspaceId: workspace.id, directory: workspace.directory });
      await paseo.terminals.create({ workspaceId: workspace.id, name: shell.title, command: shell.command, args: shell.args });
    },
  });
  client.addSettingsScreen({ id: "defaults", title: "Docker Sandboxes", icon: DOCKER_ICON, Component: SettingsScreen });
  return () => {};
}
