import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { handleAgentApi } from "./http";

const root = path.join(process.cwd(), "dist");
const port = Number(process.env.PORT || 4182);
const host = process.env.HOST || "127.0.0.1";
const mime: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon"
};
const resolvedRoot = path.resolve(root);

createServer(async (request, response) => {
  try {
    if (await handleAgentApi(request, response)) return;
    if (!["GET", "HEAD"].includes(request.method || "GET")) {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      response.end("Method not allowed");
      return;
    }
    let requested: string;
    try {
      requested = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
    } catch {
      response.statusCode = 400;
      response.end("Bad request");
      return;
    }
    const safe = requested.replace(/^\/+/, "");
    const candidate = path.resolve(root, safe);
    const insideRoot = candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${path.sep}`);
    const requestedAsset = Boolean(path.extname(safe));
    let file = candidate;
    const isFile = insideRoot && Boolean(safe) && existsSync(file) && statSync(file).isFile();
    if (!isFile) {
      if (requestedAsset || !insideRoot) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      file = path.join(root, "index.html");
    }
    const extension = path.extname(file);
    response.setHeader("Content-Type", mime[extension] || "application/octet-stream");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Cache-Control",
      path.basename(file) === "index.html"
        ? "no-store"
        : /-[A-Za-z0-9_-]{8,}\./.test(path.basename(file))
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600"
    );
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file).on("error", () => {
      if (!response.headersSent) response.statusCode = 404;
      response.end("Not found");
    }).pipe(response);
  } catch (error) {
    console.error("PitchRadar HTTP handler failed", {
      method: request.method,
      url: request.url,
      error: error instanceof Error ? error.message : String(error)
    });
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    response.end("Internal server error");
  }
}).listen(port, host, () => {
  console.log(`PitchRadar product + agent running at http://${host}:${port}`);
});
