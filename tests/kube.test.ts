import { describe, expect, it } from "vitest";
import { GUEST_KUBECONFIG, kubeEnabled, kubeSelected } from "../shared/kube";
import { sandboxSettingsSchema } from "../shared/settings";
import { authOf, guestKubeconfig, guestServer, hostContexts, hostKubeconfigPath, type KubeDoc } from "../server/kube";
import { WRAPPER_SOURCE } from "../server/wrapper-source";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", "172.16.0.103", "dev-headless"]);

function doc(): KubeDoc {
  return {
    "current-context": "homelab-dev",
    clusters: [
      { name: "dev-headless", cluster: { server: "https://172.16.0.103:6443", "certificate-authority-data": "Q0E=" } },
      { name: "k3d", cluster: { server: "https://0.0.0.0:38233", "certificate-authority-data": "Q0E=" } },
      { name: "public", cluster: { server: "https://k8s.example.com:6443", "certificate-authority-data": "Q0E=" } },
      { name: "named", cluster: { server: "https://127.0.0.1:6443", "tls-server-name": "kubernetes" } },
      { name: "eks", cluster: { server: "https://abc.eks.amazonaws.com" } },
    ],
    users: [
      { name: "admin", user: { "client-certificate-data": "Q0VSVA==", "client-key-data": "S0VZ" } },
      { name: "k3d-admin", user: { "client-certificate-data": "Q0VSVA==", "client-key-data": "S0VZ" } },
      { name: "sa", user: { tokenFile: "/var/run/token" } },
      { name: "aws", user: { exec: { command: "aws", args: ["eks", "get-token"] } } },
      { name: "unused", user: { token: "never" } },
    ],
    contexts: [
      { name: "homelab-dev", context: { cluster: "dev-headless", user: "admin", namespace: "provena" } },
      { name: "k3d-agentic", context: { cluster: "k3d", user: "k3d-admin" } },
      { name: "public", context: { cluster: "public", user: "sa" } },
      { name: "named", context: { cluster: "named", user: "admin" } },
      { name: "eks", context: { cluster: "eks", user: "aws" } },
      { name: "broken", context: { cluster: "gone", user: "admin" } },
    ],
  };
}

describe("guestServer", () => {
  it("moves a server on this host to host.docker.internal and keeps its host as the TLS name", () => {
    expect(guestServer("https://172.16.0.103:6443", LOCAL)).toEqual({
      server: "https://host.docker.internal:6443",
      tlsServerName: "172.16.0.103",
      hostPort: 6443,
    });
    expect(guestServer("https://0.0.0.0:38233", LOCAL).server).toBe("https://host.docker.internal:38233");
    expect(guestServer("https://127.0.0.2:6443", LOCAL).tlsServerName).toBe("127.0.0.2");
    expect(guestServer("https://[::1]:6443", LOCAL).tlsServerName).toBe("::1");
    expect(guestServer("https://localhost", LOCAL)).toEqual({ server: "https://host.docker.internal:443", tlsServerName: "localhost", hostPort: 443 });
    expect(guestServer("https://dev-headless:6443/prefix", LOCAL).server).toBe("https://host.docker.internal:6443/prefix");
  });

  it("leaves other servers and unparsable ones alone", () => {
    expect(guestServer("https://k8s.example.com:6443", LOCAL)).toEqual({ server: "https://k8s.example.com:6443", tlsServerName: null, hostPort: null });
    expect(guestServer("https://172.16.1.2:6443", LOCAL).hostPort).toBeNull();
    expect(guestServer("not a url", LOCAL).server).toBe("not a url");
  });
});

describe("hostContexts", () => {
  it("lists every context with its auth, where sandboxes reach it, and why one is not available", () => {
    const contexts = hostContexts(doc(), LOCAL);
    expect(contexts.map((context) => [context.name, context.auth, context.guestServer, context.unsupported])).toEqual([
      ["homelab-dev", "client-certificate", "https://host.docker.internal:6443", null],
      ["k3d-agentic", "client-certificate", "https://host.docker.internal:38233", null],
      ["public", "token-file", "https://k8s.example.com:6443", null],
      ["named", "client-certificate", "https://host.docker.internal:6443", null],
      ["eks", "exec", "https://abc.eks.amazonaws.com", "Signs in with aws, which runs on this host"],
      ["broken", "client-certificate", null, "Its cluster gone is not in the kubeconfig"],
    ]);
    expect(contexts[0].namespace).toBe("provena");
  });

  it("tolerates a kubeconfig without lists", () => {
    expect(hostContexts({ clusters: null, users: null, contexts: null }, LOCAL)).toEqual([]);
    expect(authOf(undefined)).toBe("none");
    expect(authOf({ "auth-provider": { name: "oidc" } })).toBe("auth-provider");
    expect(authOf({ username: "u", password: "p" })).toBe("basic");
  });
});

describe("guestKubeconfig", () => {
  it("keeps only the chosen contexts with their clusters and users, servers on this host moved", () => {
    const built = guestKubeconfig(doc(), { names: ["homelab-dev", "k3d-agentic"], local: LOCAL });
    expect(built.contexts).toEqual(["homelab-dev", "k3d-agentic"]);
    expect(built.skipped).toEqual([]);
    expect(built.hostPorts).toEqual([6443, 38233]);
    expect(built.config).toMatchObject({ apiVersion: "v1", kind: "Config", "current-context": "homelab-dev" });
    expect(built.config.clusters).toEqual([
      {
        name: "dev-headless",
        cluster: { server: "https://host.docker.internal:6443", "certificate-authority-data": "Q0E=", "tls-server-name": "172.16.0.103" },
      },
      {
        name: "k3d",
        cluster: { server: "https://host.docker.internal:38233", "certificate-authority-data": "Q0E=", "tls-server-name": "0.0.0.0" },
      },
    ]);
    expect(built.config.users?.map((user) => user.name)).toEqual(["admin", "k3d-admin"]);
    // The host's own document is untouched.
    expect(doc().clusters?.[0].cluster.server).toBe("https://172.16.0.103:6443");
  });

  it("keeps a TLS name the cluster already has, and shares a user between contexts once", () => {
    const built = guestKubeconfig(doc(), { names: ["named", "homelab-dev"], local: LOCAL });
    expect(built.config.clusters?.find((entry) => entry.name === "named")?.cluster["tls-server-name"]).toBe("kubernetes");
    expect(built.config.users?.map((user) => user.name)).toEqual(["admin"]);
  });

  it("applies the repository's namespaces and leaves the host's elsewhere", () => {
    const built = guestKubeconfig(doc(), {
      names: ["homelab-dev", "k3d-agentic"],
      namespaces: { "k3d-agentic": " keycloak ", "homelab-dev": "  " },
      local: LOCAL,
    });
    expect(built.config.contexts?.map((entry) => [entry.name, entry.context.namespace])).toEqual([
      ["homelab-dev", "provena"],
      ["k3d-agentic", "keycloak"],
    ]);
  });

  it("picks the repository's default, else the host's current context, else the first one", () => {
    const names = ["homelab-dev", "k3d-agentic"];
    expect(guestKubeconfig(doc(), { names, current: "k3d-agentic", local: LOCAL }).config["current-context"]).toBe("k3d-agentic");
    expect(guestKubeconfig(doc(), { names, current: "eks", local: LOCAL }).config["current-context"]).toBe("homelab-dev");
    expect(guestKubeconfig(doc(), { names: ["k3d-agentic", "named"], local: LOCAL }).config["current-context"]).toBe("k3d-agentic");
    expect(guestKubeconfig(doc(), { names: [], local: LOCAL }).config["current-context"]).toBeUndefined();
    // No default: kubectl without --context fails instead of reaching a host cluster.
    const none = guestKubeconfig(doc(), { names, current: "k3d-agentic", noDefault: true, local: LOCAL }).config;
    expect(none["current-context"]).toBeUndefined();
    expect(none.contexts?.map((entry) => entry.name)).toEqual(names);
  });

  it("reads a token file in, since the guest has none, and leaves out what it cannot use", () => {
    const built = guestKubeconfig(doc(), {
      names: ["public", "eks", "broken", "gone"],
      local: LOCAL,
      readFile: (path) => {
        expect(path).toBe("/var/run/token");
        return "t0ken\n";
      },
    });
    expect(built.contexts).toEqual(["public"]);
    expect(built.config.users).toEqual([{ name: "sa", user: { token: "t0ken" } }]);
    expect(built.hostPorts).toEqual([]);
    expect(built.skipped).toEqual([
      { name: "eks", reason: "Signs in with aws, which runs on this host" },
      { name: "broken", reason: "Its cluster gone is not in the kubeconfig" },
      { name: "gone", reason: "Not in this host's kubeconfig" },
    ]);
    const unreadable = guestKubeconfig(doc(), {
      names: ["public"],
      local: LOCAL,
      readFile: () => {
        throw new Error("EACCES");
      },
    });
    expect(unreadable.contexts).toEqual([]);
    expect(unreadable.skipped[0].reason).toBe("Its token file /var/run/token is unreadable: EACCES");
  });
});

describe("Kubernetes choices", () => {
  it("follow the global switch and list unless the repository chose for itself", () => {
    const settings = sandboxSettingsSchema.parse({
      kube: true,
      kubeContexts: ["homelab-dev", "public"],
      repos: {
        a: { kubeContexts: { public: false, "k3d-agentic": true } },
        b: { kube: false },
      },
    });
    expect(kubeSelected(settings, "a")).toEqual(["homelab-dev", "k3d-agentic"]);
    expect(kubeSelected(settings, "b")).toEqual([]);
    expect(kubeSelected(settings, "other")).toEqual(["homelab-dev", "public"]);
    const off = sandboxSettingsSchema.parse({ kubeContexts: ["homelab-dev"], repos: { a: { kube: true } } });
    expect(kubeEnabled(off, "other")).toBe(false);
    expect(kubeSelected(off, "other")).toEqual([]);
    expect(kubeSelected(off, "a")).toEqual(["homelab-dev"]);
  });

  it("are off by default", () => {
    const settings = sandboxSettingsSchema.parse({});
    expect(settings).toMatchObject({ kube: false, kubeconfig: "", kubeContexts: [] });
  });

  it("read the configured kubeconfig, else KUBECONFIG, else ~/.kube/config", () => {
    expect(hostKubeconfigPath({ kubeconfig: "~/k/config" }, {}, "/home/me")).toBe("/home/me/k/config");
    expect(hostKubeconfigPath({ kubeconfig: "" }, { KUBECONFIG: "/a:/b" }, "/home/me")).toBe("/a:/b");
    expect(hostKubeconfigPath({ kubeconfig: " " }, {}, "/home/me")).toBe("/home/me/.kube/config");
  });

  it("name the same guest kubeconfig in the wrapper", () => {
    expect(WRAPPER_SOURCE).toContain(`const GUEST_KUBECONFIG = '${GUEST_KUBECONFIG}';`);
  });
});
