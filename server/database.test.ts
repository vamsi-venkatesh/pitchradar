import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseConfigured, databaseHealth } from "./database";
import type { RuntimeState } from "./types";

describe("database safety boundary", () => {
  it("never connects the test process to the configured operating database", async () => {
    expect(process.env.VITEST).toBe("true");
    expect(databaseConfigured()).toBe(false);
    await expect(databaseHealth()).resolves.toEqual({
      configured: false,
      reachable: false,
      mode: "local_json"
    });
  });
});

describe("withRuntimeStateLock", () => {
  // The real module refuses to build a pool under Vitest (VITEST=true), so the
  // lock path is exercised against a fully mocked `pg` module: we flip the env
  // guard for a fresh module instance whose Pool never opens a socket, then
  // assert the SQL it issues. No real database is ever reachable here.
  afterEach(() => {
    process.env.VITEST = "true";
    delete process.env.PITCHRADAR_DATABASE_URL;
    vi.doUnmock("pg");
    vi.resetModules();
  });

  it("runs read-modify-write in one transaction with select ... for update", async () => {
    const storedState: RuntimeState = {
      version: 1,
      selections: { "event-1": "shortlist" },
      pipelineOverrides: {},
      actions: [],
      memories: [],
      messages: []
    };
    const issued: { text: string; values?: unknown[] }[] = [];
    const fakeClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        issued.push({ text, values });
        if (/for update/i.test(text)) return { rows: [{ state: storedState }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    };
    class FakePool {
      connect = vi.fn(async () => fakeClient);
      query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
      end = vi.fn(async () => {});
    }
    vi.doMock("pg", () => ({ Pool: FakePool }));
    vi.resetModules();
    process.env.VITEST = "false";
    process.env.PITCHRADAR_DATABASE_URL = "postgres://mocked-by-vitest/never-connected";

    const database = await import("./database");
    expect(database.databaseConfigured()).toBe(true);

    const updated = await database.withRuntimeStateLock((current) => {
      expect(current).toEqual(storedState);
      return { ...current!, selections: { ...current!.selections, "event-2": "watch" } };
    });

    expect(updated.selections).toEqual({ "event-1": "shortlist", "event-2": "watch" });

    const texts = issued.map((entry) => entry.text.toLowerCase());
    expect(texts[0]).toBe("begin");
    expect(texts[1]).toContain("select state from agent_runtime_state");
    expect(texts[1]).toContain("for update");
    expect(texts[2]).toContain("insert into agent_runtime_state");
    expect(texts[2]).toContain("on conflict (tenant_id, app_id)");
    expect(texts[3]).toBe("commit");
    expect(texts).toHaveLength(4);

    // The write happened inside the same locked transaction with the updated state.
    const upsert = issued[2];
    expect(upsert.values?.[0]).toBe("demo-operator");
    expect(upsert.values?.[1]).toBe("event_ops");
    expect(JSON.parse(upsert.values?.[2] as string).selections["event-2"]).toBe("watch");
    expect(fakeClient.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the client when the updater throws", async () => {
    const issued: string[] = [];
    const fakeClient = {
      query: vi.fn(async (text: string) => {
        issued.push(text.toLowerCase());
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    };
    class FakePool {
      connect = vi.fn(async () => fakeClient);
      query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
      end = vi.fn(async () => {});
    }
    vi.doMock("pg", () => ({ Pool: FakePool }));
    vi.resetModules();
    process.env.VITEST = "false";
    process.env.PITCHRADAR_DATABASE_URL = "postgres://mocked-by-vitest/never-connected";

    const database = await import("./database");
    await expect(
      database.withRuntimeStateLock(() => {
        throw new Error("updater failed");
      })
    ).rejects.toThrow("updater failed");

    expect(issued.at(-1)).toBe("rollback");
    expect(issued).not.toContain("commit");
    expect(fakeClient.release).toHaveBeenCalledOnce();
  });
});
