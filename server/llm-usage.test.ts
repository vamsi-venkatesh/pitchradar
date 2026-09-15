import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getTodayLlmUsage, recordLlmUsage } from "./llm-usage";

describe("PitchRadar LLM usage accounting", () => {
  // Vitest sets VITEST=true before application modules load, so the module
  // must never open a pool against the owner's real database under tests.
  it("resolves zero usage as a silent no-op without a database", async () => {
    await expect(getTodayLlmUsage()).resolves.toEqual({
      promptTokens: 0,
      completionTokens: 0,
      total: 0
    });
  });

  it("records usage as a silent no-op without a database", async () => {
    await expect(recordLlmUsage({
      model: "deepseek-v4-flash",
      promptTokens: 1200,
      completionTokens: 340
    })).resolves.toBeUndefined();
  });

  it("ships migration 010 creating llm_usage with a created_at index", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "db", "migrations", "010_llm_usage.sql"),
      "utf8"
    );
    expect(sql).toContain("create table if not exists llm_usage");
    expect(sql).toContain("id uuid primary key default gen_random_uuid()");
    expect(sql).toContain("created_at timestamptz not null default now()");
    expect(sql).toContain("model text not null");
    expect(sql).toContain("prompt_tokens integer not null");
    expect(sql).toContain("completion_tokens integer not null");
    expect(sql).toMatch(/create index if not exists llm_usage_created_at_idx\s+on llm_usage \(created_at desc\)/);
  });
});
