import { beforeEach, describe, expect, it } from "vitest";
import {
  GatewayRequestConflict,
  resetGatewayRequestsForTests,
  runGatewayRequestOnce
} from "./gateway-idempotency";

beforeEach(() => {
  resetGatewayRequestsForTests();
});

describe("messaging gateway idempotency", () => {
  it("returns one shared result for concurrent and later retries", async () => {
    let executions = 0;
    const operation = async () => {
      executions += 1;
      await Promise.resolve();
      return { result: "recorded" };
    };
    const [first, second] = await Promise.all([
      runGatewayRequestOnce("message-1", "chat", operation),
      runGatewayRequestOnce("message-1", "chat", operation)
    ]);
    expect(first).toEqual({ result: "recorded" });
    expect(second).toEqual(first);
    expect(await runGatewayRequestOnce("message-1", "chat", operation)).toEqual(first);
    expect(executions).toBe(1);
  });

  it("rejects reuse for a different action or after an unknown failure", async () => {
    await runGatewayRequestOnce("message-2", "chat", async () => ({ ok: true }));
    await expect(
      runGatewayRequestOnce("message-2", "action:1:approve", async () => ({ ok: true }))
    ).rejects.toBeInstanceOf(GatewayRequestConflict);

    await expect(
      runGatewayRequestOnce("message-3", "chat", async () => {
        throw new Error("unknown outcome");
      })
    ).rejects.toThrow("unknown outcome");
    await expect(
      runGatewayRequestOnce("message-3", "chat", async () => ({ ok: true }))
    ).rejects.toBeInstanceOf(GatewayRequestConflict);
  });
});
