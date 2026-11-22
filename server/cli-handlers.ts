import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CLI_IDS, CLI_TOOLS, cliEnabled, cliScope } from "../shared/cli-tools";
import {
  cliInstallRpc,
  cliLatestRpc,
  cliRemoveUnusedRpc,
  cliRepoRpc,
  cliTestRpc,
  cliToolsRpc,
  cliTokenRpc,
} from "../shared/rpc";
import { formatMount } from "../shared/spec";
import {
  CLI_QUALIFIED_ARCHES,
  cliArch,
  cliCredentialPresent,
  cliDirs,
  installCli,
  installStatus,
  installedVersions,
  latestRelease,
  readInstalled,
  removeUnusedCli,
  sandboxKit,
  storeClaudeToken,
  testCli,
  writeCliPlan,
} from "./cli-tools";
import type { ServerDeps } from "./hooks";
import { listSandboxes } from "./sbx";
import { buildSpec, templateFor } from "./spec-builder";
import { readSandboxState } from "./state";

/** RPCs of the additional CLIs (`shared/cli-tools.ts`): installs and updates, a repository's choices, sign-ins. */
export function registerCliHandlers(server: PluginServerContext, deps: ServerDeps): void {
  const { paths } = deps;

  server.handle(cliToolsRpc, async () => {
    const settings = await deps.readSettings();
    const installed = readInstalled(paths);
    const sandboxes = await listSandboxes(paths).catch(() => []);
    return {
      arch: process.arch,
      qualified: cliArch() !== null,
      scope: settings.cliTools.scope,
      networkOpen: settings.networkAllow.includes("**"),
      running: sandboxes.some((sandbox) => sandbox.status === "running"),
      tools: CLI_IDS.map((id) => {
        const tool = CLI_TOOLS[id];
        const status = installStatus(id);
        return {
          id,
          label: tool.label,
          vendor: tool.vendor,
          pinned: tool.pinned.version,
          active: installed[id]?.version ?? null,
          installedAt: installed[id]?.installedAt ?? null,
          versions: installedVersions(paths, id),
          installing: status.installing,
          target: status.target,
          error: status.error,
          enabled: settings.cliTools.enabled.includes(id),
          repos: Object.values(settings.repos).filter((repo) => repo.cliTools?.[id] === true).length,
          login: tool.login,
          credential: tool.credential.kind,
          globalCredential: cliCredentialPresent(paths, "", id, "global"),
          hosts: tool.hosts,
        };
      }),
    };
  });

  server.handle(cliInstallRpc, async ({ id, release }) => {
    if (!cliArch()) throw new Error(`the additional CLIs were qualified on ${CLI_QUALIFIED_ARCHES.join(", ")} only; this host is ${process.arch}`);
    const target = release === "pinned" ? CLI_TOOLS[id].pinned : await latestRelease(id, fetch, cliArch()!);
    // In the background: the cli.tools status shows it running, then the version or the error.
    installCli(paths, id, target).catch(() => undefined);
    return { ok: true as const };
  });

  server.handle(cliLatestRpc, async ({ id }) => ({ version: (await latestRelease(id, fetch, cliArch() ?? "x64")).version }));

  server.handle(cliRemoveUnusedRpc, async () => {
    const sandboxes = await listSandboxes(paths);
    // A running session may still use an older version through its shims.
    if (sandboxes.some((sandbox) => sandbox.status === "running")) {
      throw new Error("Stop every sandbox first: a running session may still use an older version");
    }
    return { removed: removeUnusedCli(paths) };
  });

  server.handle(cliRepoRpc, async ({ workspaceId, directory }) => {
    const settings = await deps.readSettings();
    const { spec, cli } = await buildSpec({ settings, workspaceId, cwd: directory, paths, prepare: false });
    const { repoKey } = spec;
    const repo = settings.repos[repoKey];
    const state = readSandboxState(paths, spec.name);
    const sandbox = (await listSandboxes(paths).catch(() => [])).find((entry) => entry.name === spec.name);
    const kit = cli?.kit ?? (await sandboxKit(paths, state, templateFor(settings, repoKey), "claude"));
    const scope = cliScope(settings, repoKey);
    const installed = readInstalled(paths);
    const mountPath = cliDirs(paths).authGlobal;
    const needed = cli?.mount !== null && cli?.mount !== undefined;
    return {
      scope,
      repoScope: repo?.cliScope ?? null,
      globalScope: settings.cliTools.scope,
      kit,
      sandbox: { name: spec.name, status: sandbox?.status ?? null },
      mount: {
        path: mountPath,
        needed,
        applied: sandbox && state?.mounts ? state.mounts.includes(formatMount({ path: mountPath, readOnly: false })) : null,
      },
      clis: CLI_IDS.map((id) => {
        const tool = CLI_TOOLS[id];
        const ownAgent = tool.agent !== null && tool.agent === kit;
        return {
          id,
          label: tool.label,
          enabled: cliEnabled(settings, repoKey, id),
          choice: repo?.cliTools?.[id] ?? null,
          global: settings.cliTools.enabled.includes(id),
          unavailable: ownAgent ? `the sandbox runs ${tool.label} as its agent` : null,
          active: installed[id]?.version ?? null,
          credential: tool.credential.kind,
          signedIn: cliCredentialPresent(paths, spec.claudeConfigDir, id, scope),
          login: tool.login,
        };
      }),
    };
  });

  server.handle(cliTestRpc, async ({ workspaceId, directory, id }) => {
    const settings = await deps.readSettings();
    const { spec, cli } = await buildSpec({ settings, workspaceId, cwd: directory, paths, prepare: false });
    if (!cli?.ids.includes(id)) throw new Error(`${CLI_TOOLS[id].label} is not turned on for this repository's sandboxes`);
    const sandbox = (await listSandboxes(paths)).find((entry) => entry.name === spec.name);
    // sbx exec would start a stopped sandbox: a test never does.
    if (sandbox?.status !== "running") throw new Error("The sandbox is not running: start an agent or the Sandbox terminal first");
    writeCliPlan(cli, spec.name);
    return testCli(paths, spec.name, id, cli.generations[1]!.dir);
  });

  server.handle(cliTokenRpc, async ({ target, token }) => {
    if (target === null) {
      storeClaudeToken(paths, null, "global", token);
      return { scope: "global" as const };
    }
    const settings = await deps.readSettings();
    const { spec } = await buildSpec({ settings, workspaceId: target.workspaceId, cwd: target.directory, paths, prepare: false });
    const scope = cliScope(settings, spec.repoKey);
    storeClaudeToken(paths, spec.claudeConfigDir, scope, token);
    return { scope };
  });
}
