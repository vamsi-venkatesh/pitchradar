import { createHash } from "node:crypto";
import type { RegisteredSource, SourceHealthState } from "../src/source-registry";
import { assertPublicUrl } from "./web";

const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

export interface SourceProbeResult {
  sourceId: string;
  sourceName: string;
  requestedUrl: string;
  finalUrl: string;
  checkedAt: string;
  state: SourceHealthState;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  title?: string;
  bodyHash?: string;
  bodyText?: string;
  bytesReviewed: number;
  error?: string;
}

interface ProbeOptions {
  fetchImpl?: typeof fetch;
  assertUrl?: typeof assertPublicUrl;
  maxBytes?: number;
  timeoutMs?: number;
}

function classify(status: number | null, supported: boolean, error?: string): SourceHealthState {
  if (error || status === null) return "unavailable";
  if ([401, 403, 429].includes(status)) return "restricted";
  if ([404, 410].includes(status)) return "broken";
  if (status >= 500 || status >= 400 || !supported) return "degraded";
  return "healthy";
}

async function readBoundedBody(response: Response, maxBytes: number) {
  if (!response.body) return { body: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total === maxBytes) {
        const next = await reader.read();
        truncated = !next.done && Boolean(next.value?.byteLength);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated };
}

function pageTitle(bodyText: string, fallback: string) {
  return bodyText.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim() || fallback;
}

export async function probeSource(
  source: Pick<RegisteredSource, "id" | "name" | "baseUrl">,
  options: ProbeOptions = {}
): Promise<SourceProbeResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const assertUrl = options.assertUrl || assertPublicUrl;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const checkedAt = new Date().toISOString();
  let url: URL | undefined;
  let response: Response | undefined;
  let cookieHeader = "";

  try {
    url = await assertUrl(source.baseUrl);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      response = await fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: "text/html,application/xhtml+xml,application/ld+json,application/json,application/xml,text/xml,application/pdf;q=0.8,*/*;q=0.2",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.6",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          "User-Agent": "PitchRadar/0.2 (+source health and event discovery; low-frequency)"
        }
      });
      const setCookie = response.headers.get("set-cookie");
      const cookie = setCookie?.match(/^([^=;,\s]+)=([^;,\s]*)/);
      if (cookie) cookieHeader = `${cookie[1]}=${cookie[2]}`;
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect did not provide a destination.");
      const nextUrl = await assertUrl(new URL(location, url).toString());
      if (nextUrl.hostname !== url.hostname) cookieHeader = "";
      url = nextUrl;
    }

    if (!response) throw new Error("Source returned no response.");
    const contentType = response.headers.get("content-type");
    const supported = /(html|json|xml|text|pdf)/i.test(contentType || "");
    const state = classify(response.status, supported);
    if (state !== "healthy") {
      await response.body?.cancel().catch(() => undefined);
      return {
        sourceId: source.id,
        sourceName: source.name,
        requestedUrl: source.baseUrl,
        finalUrl: url.toString(),
        checkedAt,
        state,
        ok: false,
        status: response.status,
        contentType,
        bytesReviewed: 0,
        error: state === "restricted"
          ? "The source exists but blocks or rate-limits automated access."
          : `Source returned HTTP ${response.status}.`
      };
    }

    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      if (/pdf/i.test(contentType || "")) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          requestedUrl: source.baseUrl,
          finalUrl: url.toString(),
          checkedAt,
          state: "healthy",
          ok: true,
          status: response.status,
          contentType,
          title: url.pathname.split("/").pop() || url.hostname,
          bytesReviewed: 0
        };
      }
      return {
        sourceId: source.id,
        sourceName: source.name,
        requestedUrl: source.baseUrl,
        finalUrl: url.toString(),
        checkedAt,
        state: "degraded",
        ok: false,
        status: response.status,
        contentType,
        bytesReviewed: 0,
        error: `Source response exceeds the ${maxBytes}-byte review limit.`
      };
    }

    const { body, truncated } = await readBoundedBody(response, maxBytes);
    if (truncated && !/pdf/i.test(contentType || "")) {
      return {
        sourceId: source.id,
        sourceName: source.name,
        requestedUrl: source.baseUrl,
        finalUrl: url?.toString() || source.baseUrl,
        checkedAt,
        state: "degraded",
        ok: false,
        status: response.status,
        contentType,
        bytesReviewed: body.byteLength,
        error: `Source response exceeds the ${maxBytes}-byte review limit.`
      };
    }
    const isText = /(html|json|xml|text)/i.test(contentType || "");
    const bodyText = isText ? new TextDecoder().decode(body) : undefined;
    return {
      sourceId: source.id,
      sourceName: source.name,
      requestedUrl: source.baseUrl,
      finalUrl: url?.toString() || source.baseUrl,
      checkedAt,
      state: "healthy",
      ok: true,
      status: response.status,
      contentType,
      title: bodyText ? pageTitle(bodyText, url.hostname) : url.pathname.split("/").pop() || url.hostname,
      bodyHash: createHash("sha256").update(body).digest("hex"),
      bodyText,
      bytesReviewed: body.byteLength
    };
  } catch (error) {
    return {
      sourceId: source.id,
      sourceName: source.name,
      requestedUrl: source.baseUrl,
      finalUrl: url?.toString() || source.baseUrl,
      checkedAt,
      state: "unavailable",
      ok: false,
      status: response?.status ?? null,
      contentType: response?.headers.get("content-type") ?? null,
      bytesReviewed: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function probeSources(
  sources: Array<Pick<RegisteredSource, "id" | "name" | "baseUrl">>,
  options: ProbeOptions & { concurrency?: number } = {}
) {
  const concurrency = Math.max(1, Math.min(6, options.concurrency || 4));
  const results: SourceProbeResult[] = new Array(sources.length);
  let cursor = 0;
  async function worker() {
    while (cursor < sources.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await probeSource(sources[index], options);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, () => worker()));
  return results;
}

export interface ExtractedOccurrence {
  sourceRecordKey?: string;
  rawName: string;
  rawLocation?: string;
  rawStartsAt?: string;
  rawEndsAt?: string;
  rawPayload: Record<string, unknown>;
  contentHash: string;
}

type TribeEvent = {
  id?: number | string;
  title?: string;
  url?: string;
  start_date?: string;
  end_date?: string;
  venue?: {
    venue?: string;
    city?: string;
    zip?: string;
  };
};

function eventNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(eventNodes);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...eventNodes(record["@graph"])];
}

function schemaTypes(value: unknown) {
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
}

function locationLabel(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const location = value as Record<string, unknown>;
  const address = location.address && typeof location.address === "object"
    ? location.address as Record<string, unknown>
    : {};
  return [location.name, address.addressLocality, address.postalCode]
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .join(", ") || undefined;
}

export function extractJsonLdEvents(bodyText: string): ExtractedOccurrence[] {
  const scripts = [...bodyText.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];
  const occurrences: ExtractedOccurrence[] = [];
  for (const match of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    for (const node of eventNodes(parsed)) {
      const types = schemaTypes(node["@type"]);
      if (!types.some((type) => /Event$/i.test(type))) continue;
      if (typeof node.name !== "string" || !node.name.trim()) continue;
      const rawPayload = JSON.parse(JSON.stringify(node)) as Record<string, unknown>;
      occurrences.push({
        sourceRecordKey:
          typeof node["@id"] === "string" ? node["@id"] :
          typeof node.url === "string" ? node.url :
          undefined,
        rawName: node.name.trim(),
        rawLocation: locationLabel(node.location),
        rawStartsAt: typeof node.startDate === "string" ? node.startDate : undefined,
        rawEndsAt: typeof node.endDate === "string" ? node.endDate : undefined,
        rawPayload,
        contentHash: createHash("sha256")
          .update(JSON.stringify({
            name: node.name,
            startDate: node.startDate,
            endDate: node.endDate,
            location: locationLabel(node.location),
            url: node.url,
            id: node["@id"]
          }))
          .digest("hex")
      });
    }
  }
  return [...new Map(occurrences.map((item) => [item.contentHash, item])).values()];
}

export function extractTribeEvents(bodyText: string): ExtractedOccurrence[] {
  let payload: { events?: TribeEvent[] };
  try {
    payload = JSON.parse(bodyText) as { events?: TribeEvent[] };
  } catch {
    return [];
  }
  if (!Array.isArray(payload.events)) return [];
  const occurrences = payload.events.flatMap((event): ExtractedOccurrence[] => {
    if (typeof event.title !== "string" || !event.title.trim()) return [];
    const location = [event.venue?.venue, event.venue?.city, event.venue?.zip]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .join(", ") || undefined;
    const rawPayload = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    return [{
      sourceRecordKey:
        typeof event.id === "number" || typeof event.id === "string"
          ? String(event.id)
          : event.url,
      rawName: event.title.trim(),
      rawLocation: location,
      rawStartsAt: event.start_date,
      rawEndsAt: event.end_date,
      rawPayload,
      contentHash: createHash("sha256")
        .update(JSON.stringify({
          id: event.id,
          name: event.title,
          startDate: event.start_date,
          endDate: event.end_date,
          location,
          url: event.url
        }))
        .digest("hex")
    }];
  });
  return [...new Map(occurrences.map((item) => [item.contentHash, item])).values()];
}
