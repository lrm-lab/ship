import { describe, expect, test } from "bun:test";
import { createShutdown } from "#src/shutdown";

/** A shutdown whose exit and log are recorded, with a short timeout. */
function setup(steps: { name: string; run: () => Promise<unknown> }[], timeoutMs = 50) {
  const exits: number[] = [];
  const logs: string[] = [];
  const shutdown = createShutdown({
    steps,
    timeoutMs,
    exit: (code) => void exits.push(code),
    log: (message) => void logs.push(message),
  });
  return { shutdown, exits, logs };
}

describe("createShutdown", () => {
  test("runs the steps in order, then exits 0", async () => {
    const order: string[] = [];
    const { shutdown, exits, logs } = setup([
      { name: "stop server", run: async () => void order.push("stop") },
      { name: "close database", run: async () => void order.push("close") },
    ]);
    await shutdown();
    expect(order).toEqual(["stop", "close"]);
    expect(exits).toEqual([0]);
    expect(logs).toEqual([]);
  });

  test("runs once however often it is called", async () => {
    let runs = 0;
    const { shutdown, exits } = setup([{ name: "stop", run: async () => void runs++ }]);
    await Promise.all([shutdown(), shutdown()]);
    await shutdown();
    expect(runs).toBe(1);
    expect(exits).toEqual([0]);
  });

  test("a failing step is logged, the later steps still run, and the exit code is 1", async () => {
    const order: string[] = [];
    const { shutdown, exits, logs } = setup([
      {
        name: "stop server",
        run: async () => {
          throw new Error("port busy");
        },
      },
      { name: "close database", run: async () => void order.push("close") },
    ]);
    await shutdown();
    expect(order).toEqual(["close"]);
    expect(exits).toEqual([1]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("stop server");
    expect(logs[0]).toContain("port busy");
  });

  test("a step that hangs does not hold the process: it exits 1 after the timeout", async () => {
    const { shutdown, exits, logs } = setup(
      [{ name: "stop server", run: () => new Promise(() => {}) }],
      30,
    );
    await shutdown();
    expect(exits).toEqual([1]);
    expect(logs[0]).toContain("30 ms");
  });
});
