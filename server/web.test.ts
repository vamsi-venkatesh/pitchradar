import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import {
  assertPublicUrl,
  fetchPublicPage,
  makePinnedLookup,
  resolvePublicUrl,
  webInternals
} from "./web";

const originalLookup = webInternals.lookup;
const originalCreateDispatcher = webInternals.createDispatcher;
const originalFetchImpl = webInternals.fetchImpl;

afterEach(() => {
  webInternals.lookup = originalLookup;
  webInternals.createDispatcher = originalCreateDispatcher;
  webInternals.fetchImpl = originalFetchImpl;
});

function fakeDispatcher(): Dispatcher {
  return { close: async () => undefined } as unknown as Dispatcher;
}

describe("public web boundary", () => {
  it("blocks loopback and private network targets", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:4182/private")).rejects.toThrow(/private/i);
    await expect(assertPublicUrl("http://192.168.1.10/admin")).rejects.toThrow(/private/i);
    await expect(assertPublicUrl("http://localhost:4182")).rejects.toThrow(/local/i);
    await expect(assertPublicUrl("http://[::1]/private")).rejects.toThrow(/private/i);
    await expect(assertPublicUrl("http://[::ffff:127.0.0.1]/private")).rejects.toThrow(/private/i);
    await expect(assertPublicUrl("http://100.64.0.1/private")).rejects.toThrow(/private/i);
  });

  it("blocks non-web protocols and credentialed URLs", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/HTTP/i);
    await expect(assertPublicUrl("https://user:pass@example.com")).rejects.toThrow(/credentials/i);
  });

  it("rejects a hostname that resolves to a private IP", async () => {
    webInternals.lookup = async () => [{ address: "10.13.37.1", family: 4 }];
    await expect(assertPublicUrl("http://rebind.example.com/")).rejects.toThrow(/private or unavailable/i);
    await expect(fetchPublicPage("http://rebind.example.com/")).rejects.toThrow(/private or unavailable/i);
  });

  it("rejects a hostname where any resolved address is private", async () => {
    webInternals.lookup = async () => [
      { address: "203.0.113.9", family: 4 },
      { address: "192.168.0.20", family: 4 }
    ];
    await expect(assertPublicUrl("http://mixed.example.com/")).rejects.toThrow(/private or unavailable/i);
  });
});

describe("DNS pinning", () => {
  it("resolvePublicUrl pins the exact address that passed validation", async () => {
    webInternals.lookup = async () => [{ address: "203.0.113.7", family: 4 }];
    const target = await resolvePublicUrl("https://good.example.com/page");
    expect(target.address).toBe("203.0.113.7");
    expect(target.family).toBe(4);
    expect(target.url.hostname).toBe("good.example.com");
  });

  it("makePinnedLookup answers with the pinned IP for every callback shape and never re-resolves", () => {
    const lookup = makePinnedLookup({ address: "203.0.113.7", family: 4 });

    const withAll = vi.fn();
    lookup("attacker-controlled.example.com", { all: true }, withAll);
    expect(withAll).toHaveBeenCalledWith(null, [{ address: "203.0.113.7", family: 4 }]);

    const withoutAll = vi.fn();
    lookup("attacker-controlled.example.com", {}, withoutAll);
    expect(withoutAll).toHaveBeenCalledWith(null, "203.0.113.7", 4);

    const bare = vi.fn();
    lookup("attacker-controlled.example.com", bare as never);
    expect(bare).toHaveBeenCalledWith(null, "203.0.113.7", 4);
  });

  it("fetchPublicPage connects through a dispatcher pinned to the validated IP", async () => {
    const pinnedTargets: Array<{ address: string; hostname: string }> = [];
    const dispatchers: Dispatcher[] = [];
    const seenByFetch: Array<{ url: string; dispatcher: Dispatcher | undefined }> = [];

    webInternals.lookup = async () => [{ address: "203.0.113.7", family: 4 }];
    webInternals.createDispatcher = (target) => {
      pinnedTargets.push({ address: target.address, hostname: target.url.hostname });
      const dispatcher = fakeDispatcher();
      dispatchers.push(dispatcher);
      return dispatcher;
    };
    webInternals.fetchImpl = async (input, init) => {
      seenByFetch.push({ url: input.toString(), dispatcher: init?.dispatcher });
      return new Response("<title>Pinned Page</title><p>hello</p>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    };

    const page = await fetchPublicPage("https://good.example.com/page");
    expect(page.title).toBe("Pinned Page");
    expect(page.finalUrl).toBe("https://good.example.com/page");
    expect(pinnedTargets).toEqual([{ address: "203.0.113.7", hostname: "good.example.com" }]);
    expect(seenByFetch).toHaveLength(1);
    // The request went through the exact dispatcher built for the validated IP.
    expect(seenByFetch[0].dispatcher).toBe(dispatchers[0]);
    // The URL keeps the hostname (Host header / SNI), not the IP.
    expect(seenByFetch[0].url).toBe("https://good.example.com/page");
  });

  it("re-validates and re-pins every redirect hop", async () => {
    const lookups: Record<string, string> = {
      "first.example.com": "203.0.113.7",
      "second.example.com": "198.51.100.42"
    };
    const pinnedTargets: Array<{ address: string; hostname: string }> = [];
    const dispatchers: Dispatcher[] = [];
    const fetchDispatchers: Array<Dispatcher | undefined> = [];
    let call = 0;

    webInternals.lookup = async (hostname) => [{ address: lookups[hostname], family: 4 }];
    webInternals.createDispatcher = (target) => {
      pinnedTargets.push({ address: target.address, hostname: target.url.hostname });
      const dispatcher = fakeDispatcher();
      dispatchers.push(dispatcher);
      return dispatcher;
    };
    webInternals.fetchImpl = async (_input, init) => {
      fetchDispatchers.push(init?.dispatcher);
      call += 1;
      if (call === 1) {
        return new Response(null, { status: 302, headers: { location: "https://second.example.com/final" } });
      }
      return new Response("<title>Second Host</title>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    };

    const page = await fetchPublicPage("https://first.example.com/start");
    expect(page.finalUrl).toBe("https://second.example.com/final");
    expect(pinnedTargets).toEqual([
      { address: "203.0.113.7", hostname: "first.example.com" },
      { address: "198.51.100.42", hostname: "second.example.com" }
    ]);
    expect(fetchDispatchers).toEqual(dispatchers);
  });

  it("real dispatcher + real fetch connect the socket to the pinned IP, keeping the hostname", async () => {
    // Loopback-only: proves the actual undici Agent honours connect.lookup and
    // that our fetchImpl accepts the Agent (npm undici fetch, not global fetch,
    // which rejects foreign dispatchers). The hostname is .invalid, so any
    // second, independent DNS resolution would fail — success means the socket
    // used exactly the pinned address.
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ host: req.headers.host }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const url = new URL(`http://pinned-host.invalid:${port}/`);
    const dispatcher = originalCreateDispatcher({ url, address: "127.0.0.1", family: 4 });
    try {
      const response = await originalFetchImpl(url, { dispatcher });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { host: string };
      expect(body.host).toBe(`pinned-host.invalid:${port}`);
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a redirect hop that resolves to a private IP", async () => {
    webInternals.lookup = async (hostname) => [
      { address: hostname === "first.example.com" ? "203.0.113.7" : "127.0.0.1", family: 4 }
    ];
    webInternals.createDispatcher = () => fakeDispatcher();
    webInternals.fetchImpl = async () =>
      new Response(null, { status: 302, headers: { location: "https://internal.example.com/secret" } });

    await expect(fetchPublicPage("https://first.example.com/start")).rejects.toThrow(/private or unavailable/i);
  });
});
