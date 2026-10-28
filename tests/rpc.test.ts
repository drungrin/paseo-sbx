import { describe, expect, it } from "vitest";
import * as rpc from "../shared/rpc";

describe("RPC contracts", () => {
  it("are named the way the daemon accepts", () => {
    // defineRpc throws at import for a name the daemon refuses, which fails the plugin's load.
    const names = Object.values(rpc).flatMap((value) => {
      const contract = value as { name?: unknown; input?: unknown } | null;
      return contract && typeof contract === "object" && contract.input && typeof contract.name === "string" ? [contract.name] : [];
    });
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9._-]*$/);
    expect(new Set(names).size).toBe(names.length);
  });
});
