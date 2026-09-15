import "dotenv/config";
import { Pool } from "pg";

/**
 * LLM usage accounting. Every model response's token usage is inserted into
 * the llm_usage table so the daily Europe/Berlin token cap in agent.ts can be
 * enforced from real numbers.
 *
 * Mirrors the database.ts convention: tests must never touch the owner's real
 * database (Vitest sets VITEST=true before application modules load), and a
 * missing PITCHRADAR_DATABASE_URL turns every function into a silent no-op
 * that resolves zeros.
 */
const connectionString = process.env.VITEST === "true"
  ? undefined
  : process.env.PITCHRADAR_DATABASE_URL?.trim();
const pool = connectionString
  ? new Pool({
      connectionString,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    })
  : null;

export interface LlmUsageSample {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface LlmDailyUsage {
  promptTokens: number;
  completionTokens: number;
  total: number;
}

export async function recordLlmUsage(sample: LlmUsageSample): Promise<void> {
  if (!pool) return;
  await pool.query(
    "insert into llm_usage (model, prompt_tokens, completion_tokens) values ($1, $2, $3)",
    [
      sample.model,
      Math.max(0, Math.round(Number(sample.promptTokens) || 0)),
      Math.max(0, Math.round(Number(sample.completionTokens) || 0))
    ]
  );
}

export async function getTodayLlmUsage(): Promise<LlmDailyUsage> {
  if (!pool) return { promptTokens: 0, completionTokens: 0, total: 0 };
  const result = await pool.query<{ prompt: number; completion: number }>(
    `select coalesce(sum(prompt_tokens), 0)::int as prompt,
            coalesce(sum(completion_tokens), 0)::int as completion
       from llm_usage
      where (created_at at time zone 'Europe/Berlin')::date
          = (now() at time zone 'Europe/Berlin')::date`
  );
  const promptTokens = result.rows[0]?.prompt ?? 0;
  const completionTokens = result.rows[0]?.completion ?? 0;
  return { promptTokens, completionTokens, total: promptTokens + completionTokens };
}

export async function closeLlmUsagePool() {
  await pool?.end();
}
