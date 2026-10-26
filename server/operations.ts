import { randomUUID } from "node:crypto";
import type { OperationView } from "../shared/rpc";

interface Operation {
  view: OperationView;
  finishedAt: number | null;
}

const operations = new Map<string, Operation>();
const KEEP_MS = 10 * 60_000;

function prune(): void {
  const now = Date.now();
  for (const [id, operation] of operations) {
    if (operation.finishedAt !== null && now - operation.finishedAt > KEEP_MS) operations.delete(id);
  }
}

/**
 * Runs a sandbox operation in the plugin process and waits up to `waitMs` for it. The daemon
 * fails a plugin RPC after 30 s while its handler keeps running, and a first sandbox creation
 * (image pull), a template save or a recreation can take longer: a slower operation returns as
 * running and the client polls `operation.get`. One operation per target at a time.
 */
export async function runOperation(
  kind: string,
  target: string,
  fn: () => Promise<unknown>,
  waitMs = 20_000,
): Promise<OperationView> {
  prune();
  for (const operation of operations.values()) {
    if (operation.view.target === target && operation.view.status === "running") {
      throw new Error(`${target} is busy: ${operation.view.kind} is still running`);
    }
  }
  const operation: Operation = {
    view: { id: randomUUID(), kind, target, status: "running", error: null, result: null, startedAt: Date.now() },
    finishedAt: null,
  };
  operations.set(operation.view.id, operation);
  const done = fn().then(
    (result) => {
      operation.view = { ...operation.view, status: "done", result: (result ?? null) as OperationView["result"] };
      operation.finishedAt = Date.now();
    },
    (error: unknown) => {
      operation.view = { ...operation.view, status: "failed", error: error instanceof Error ? error.message : String(error) };
      operation.finishedAt = Date.now();
    },
  );
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, waitMs))]);
  return operation.view;
}

export function getOperation(id: string): OperationView | null {
  prune();
  return operations.get(id)?.view ?? null;
}

/** Operations on these targets that are running or finished within the last ten minutes. */
export function operationsFor(targets: readonly string[]): OperationView[] {
  prune();
  return [...operations.values()].map((operation) => operation.view).filter((view) => targets.includes(view.target));
}
