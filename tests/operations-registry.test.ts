import { describe, expect, it } from "vitest";
import { getOperation, operationsFor, runOperation } from "../server/operations";

describe("operations", () => {
  it("returns a fast operation's result directly", async () => {
    const view = await runOperation("save-template", "paseo-a-00000001", async () => ({ ref: "r" }));
    expect(view).toMatchObject({ status: "done", result: { ref: "r" }, error: null });
  });

  it("returns a slow operation as running, then reports how it ended", async () => {
    let finish: (value: unknown) => void = () => {};
    const view = await runOperation("recreate", "paseo-a-00000002", () => new Promise((resolve) => (finish = resolve)), 10);
    expect(view.status).toBe("running");
    expect(operationsFor(["paseo-a-00000002"]).map((entry) => entry.status)).toEqual(["running"]);
    await expect(runOperation("stop", "paseo-a-00000002", async () => null)).rejects.toThrow("busy: recreate is still running");
    finish(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getOperation(view.id)?.status).toBe("done");
  });

  it("keeps the error of a failed operation", async () => {
    const view = await runOperation("publish", "paseo-a-00000003", async () => {
      throw new Error("host port 8080 is already taken");
    });
    expect(view).toMatchObject({ status: "failed", error: "host port 8080 is already taken" });
  });
});
