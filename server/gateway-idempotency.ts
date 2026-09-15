import { databaseConfigured, databaseQuery } from "./database";

interface CachedValue {
  kind: string;
  status: "processing" | "completed" | "failed_unknown";
  response?: unknown;
  promise?: Promise<unknown>;
}

const memory = new Map<string, CachedValue>();

export class GatewayRequestConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRequestConflict";
  }
}

export async function runGatewayRequestOnce<T>(
  gatewayMessageId: string,
  kind: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!gatewayMessageId || gatewayMessageId.length > 160) {
    throw new Error("A valid gatewayMessageId is required.");
  }
  if (!databaseConfigured()) {
    const existing = memory.get(gatewayMessageId);
    if (existing) {
      if (existing.kind !== kind) throw new GatewayRequestConflict("The message ID changed request kind.");
      if (existing.status === "completed") return existing.response as T;
      if (existing.promise) return existing.promise as Promise<T>;
      throw new GatewayRequestConflict("The previous gateway request outcome is unknown.");
    }
    const promise = operation();
    memory.set(gatewayMessageId, { kind, status: "processing", promise });
    try {
      const response = await promise;
      memory.set(gatewayMessageId, { kind, status: "completed", response });
      return response;
    } catch (error) {
      memory.set(gatewayMessageId, { kind, status: "failed_unknown" });
      throw error;
    }
  }

  const claimed = await databaseQuery<{ gateway_message_id: string }>(
    `insert into gateway_requests(gateway_message_id, request_kind, status)
     values ($1, $2, 'processing')
     on conflict (gateway_message_id) do nothing
     returning gateway_message_id`,
    [gatewayMessageId, kind]
  );
  if (!claimed.rowCount) {
    const existing = await databaseQuery<{
      request_kind: string;
      status: string;
      response: T | null;
    }>(
      `select request_kind, status, response
       from gateway_requests
       where gateway_message_id = $1`,
      [gatewayMessageId]
    );
    const row = existing.rows[0];
    if (row?.request_kind !== kind) {
      throw new GatewayRequestConflict("The message ID changed request kind.");
    }
    if (row?.status === "completed" && row.response) return row.response;
    throw new GatewayRequestConflict(
      "The request is already processing or its previous outcome is unknown."
    );
  }
  try {
    const response = await operation();
    await databaseQuery(
      `update gateway_requests
       set status = 'completed', response = $2::jsonb, completed_at = now()
       where gateway_message_id = $1`,
      [gatewayMessageId, JSON.stringify(response)]
    );
    return response;
  } catch (error) {
    await databaseQuery(
      `update gateway_requests
       set status = 'failed_unknown', last_error = $2, completed_at = now()
       where gateway_message_id = $1`,
      [gatewayMessageId, error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000)]
    );
    throw error;
  }
}

export function resetGatewayRequestsForTests() {
  memory.clear();
}
