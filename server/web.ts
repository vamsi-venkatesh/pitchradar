import dns from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { AgentReceipt } from "./types";

const MAX_BYTES = 750_000;
const TIMEOUT_MS = 12_000;

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map(Number);
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 198 && [18, 19].includes(parts[1])) ||
    parts[0] >= 224
  );
}

function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = normalized.match(/^::ffff:(.+)$/)?.[1];
  if (mapped) {
    if (net.isIPv4(mapped)) return isPrivateIpv4(mapped);
    const words = mapped.split(":");
    if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
      const value = Number.parseInt(words.join("").padStart(8, "0"), 16);
      return isPrivateIpv4([
        value >>> 24,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255
      ].join("."));
    }
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

export interface PinnedTarget {
  url: URL;
  /** The exact IP address that passed the private-range validation. */
  address: string;
  family: 4 | 6;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/**
 * Builds a `lookup` function that always answers with the already-validated IP,
 * regardless of what DNS would say now. Handles every callback shape Node's
 * net/tls connect may use (plain callback, options with/without `all`).
 */
export function makePinnedLookup(target: Pick<PinnedTarget, "address" | "family">) {
  return (
    _hostname: string,
    options: LookupOptions | LookupCallback,
    callback?: LookupCallback
  ) => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const wantsAll = typeof options === "object" && options !== null && Boolean(options.all);
    if (wantsAll) {
      cb(null, [{ address: target.address, family: target.family }]);
    } else {
      cb(null, target.address, target.family);
    }
  };
}

/**
 * Test seam + single source of truth for the network edges:
 * - `lookup` is the one DNS resolution used for validation AND connection.
 * - `createDispatcher` builds an undici Agent whose socket is pinned to the
 *   validated IP while the URL keeps the hostname (Host header, TLS SNI and
 *   certificate validation are unchanged).
 * - `fetchImpl` performs the request with that dispatcher.
 */
export const webInternals = {
  lookup: (hostname: string): Promise<LookupAddress[]> => dns.lookup(hostname, { all: true }),
  createDispatcher: (target: PinnedTarget): Dispatcher =>
    new Agent({ connect: { lookup: makePinnedLookup(target) } }),
  // IMPORTANT: must be undici's own fetch, not the global one. Node's global
  // fetch uses the undici build bundled with Node, which rejects a Dispatcher
  // created by the npm undici package ("invalid onRequestStart method").
  fetchImpl: ((input: string | URL, init?: RequestInit & { dispatcher?: Dispatcher }) =>
    undiciFetch(input, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>) as (
    input: string | URL,
    init?: RequestInit & { dispatcher?: Dispatcher }
  ) => Promise<Response>
};

export async function resolvePublicUrl(value: string): Promise<PinnedTarget> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only public HTTP(S) pages are allowed.");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are blocked.");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) throw new Error("Local network targets are blocked.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isPrivateIp(hostname)) throw new Error("Private network targets are blocked.");
    return { url, address: hostname, family: literalFamily as 4 | 6 };
  }
  const addresses = await webInternals.lookup(url.hostname);
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("The hostname resolves to a private or unavailable address.");
  }
  const [first] = addresses;
  return { url, address: first.address, family: first.family as 4 | 6 };
}

export async function assertPublicUrl(value: string) {
  const { url } = await resolvePublicUrl(value);
  return url;
}

/**
 * Fetches the target through a dispatcher pinned to the validated IP so a
 * second, independent DNS resolution (the rebinding window) never happens.
 * The caller owns the returned dispatcher and must close it once the response
 * body has been consumed.
 */
async function fetchPinned(
  target: PinnedTarget,
  init: RequestInit
): Promise<{ response: Response; dispatcher: Dispatcher }> {
  const dispatcher = webInternals.createDispatcher(target);
  try {
    const response = await webInternals.fetchImpl(target.url, { ...init, dispatcher });
    return { response, dispatcher };
  } catch (error) {
    await dispatcher.close().catch(() => undefined);
    throw error;
  }
}

async function readBoundedText(response: Response, maxBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        total = maxBytes;
        exceeded = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (exceeded) throw new Error("Page is larger than the live-check limit.");
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function cleanPage(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}

export async function fetchPublicPage(value: string): Promise<{
  title: string;
  text: string;
  finalUrl: string;
  receipt: AgentReceipt;
}> {
  let target = await resolvePublicUrl(value);
  let response: Response | undefined;
  let dispatcher: Dispatcher | undefined;
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      ({ response, dispatcher } = await fetchPinned(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.8",
          "User-Agent": "PitchRadar/0.1 (+event opportunity verification)"
        }
      }));
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect did not provide a destination.");
        await response.body?.cancel().catch(() => undefined);
        await dispatcher.close().catch(() => undefined);
        dispatcher = undefined;
        // Each hop is re-validated and fetched through its own pinned IP.
        target = await resolvePublicUrl(new URL(location, target.url).toString());
        continue;
      }
      break;
    }
    if (!response?.ok) throw new Error(`Public page returned HTTP ${response?.status ?? "unknown"}.`);
    const contentType = response.headers.get("content-type") || "";
    if (!/(text|html|json|xml)/i.test(contentType)) throw new Error(`Unsupported page type: ${contentType || "unknown"}.`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) throw new Error("Page is larger than the live-check limit.");
    const raw = await readBoundedText(response, MAX_BYTES);
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || target.url.hostname;
    const text = contentType.includes("json") ? raw.slice(0, 12_000) : cleanPage(raw);
    const observedAt = new Date().toISOString();
    return {
      title,
      text,
      finalUrl: target.url.toString(),
      receipt: {
        id: crypto.randomUUID(),
        tool: "fetch_public_page",
        status: "verified",
        summary: `Fetched ${title} from the public web.`,
        sourceUrl: target.url.toString(),
        observedAt,
        details: { contentType, charactersReviewed: text.length }
      }
    };
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

export async function searchPublicWeb(query: string) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  const searxng = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "");
  const observedAt = new Date().toISOString();
  if (!key && !searxng) {
    return {
      results: [],
      receipt: {
        id: crypto.randomUUID(),
        tool: "search_public_web",
        status: "unavailable",
        summary: "Broad web search needs BRAVE_SEARCH_API_KEY. Direct official-page checks remain available.",
        observedAt
      } satisfies AgentReceipt
    };
  }
  if (searxng) {
    const endpoint = new URL(`${searxng}/search`);
    endpoint.searchParams.set("q", query.slice(0, 300));
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("language", "de");
    endpoint.searchParams.set("safesearch", "1");
    const target = await resolvePublicUrl(endpoint.toString());
    const { response, dispatcher } = await fetchPinned(target, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" }
    });
    let body: { results?: Array<{ title?: string; url?: string; content?: string }> };
    try {
      if (!response.ok) throw new Error(`Self-hosted search returned HTTP ${response.status}.`);
      body = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
    const results = (body.results || []).slice(0, 8).map((item) => ({
      title: item.title || "Untitled result",
      url: item.url || "",
      description: item.content || ""
    }));
    return {
      results,
      receipt: {
        id: crypto.randomUUID(),
        tool: "search_public_web",
        status: "verified",
        summary: `Searched the public web through the private search service and found ${results.length} candidate sources.`,
        observedAt,
        details: { query, resultCount: results.length, provider: "searxng" }
      } satisfies AgentReceipt
    };
  }
  const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
  endpoint.searchParams.set("q", query.slice(0, 300));
  endpoint.searchParams.set("count", "8");
  endpoint.searchParams.set("country", "de");
  endpoint.searchParams.set("search_lang", "de");
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/json", "X-Subscription-Token": key }
  });
  if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}.`);
  const body = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  const results = (body.web?.results || []).slice(0, 8).map((item) => ({
    title: item.title || "Untitled result",
    url: item.url || "",
    description: item.description || ""
  }));
  return {
    results,
    receipt: {
      id: crypto.randomUUID(),
      tool: "search_public_web",
      status: "verified",
      summary: `Searched the public web and found ${results.length} candidate sources.`,
      observedAt,
      details: { query, resultCount: results.length }
    } satisfies AgentReceipt
  };
}
