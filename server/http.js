import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { catalogOptions, providerCatalog } from "../src/catalog.js";
import { documentPolicy } from "./policy.js";

const HOST = /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/iu;
const CACHE_LIFETIME = 120_000;
const CACHE_SIZE = 96;
const MAX_CONCURRENT = 12;

class CatalogBusy extends Error {}

function catalogCache(load, now = Date.now) {
  const stored = new Map();
  const pending = new Map();
  return async (options) => {
    const key = JSON.stringify(options);
    const cached = stored.get(key);
    if (cached) {
      stored.delete(key);
      if (cached.expires > now()) {
        stored.set(key, cached);
        return cached.page;
      }
    }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= MAX_CONCURRENT) throw new CatalogBusy();

    const request = Promise.resolve().then(() => load(options)).then((page) => {
      if (stored.size >= CACHE_SIZE) stored.delete(stored.keys().next().value);
      stored.set(key, { page, expires: now() + CACHE_LIFETIME });
      return page;
    });
    pending.set(key, request);
    try {
      return await request;
    } finally {
      pending.delete(key);
    }
  };
}

function acceptsGzip(header) {
  return typeof header === "string" && header.split(",").some((token) => {
    const [name, quality] = token.trim().toLowerCase().split(/\s*;\s*/u);
    return name === "gzip" && (!quality || (quality.startsWith("q=") && Number(quality.slice(2)) > 0));
  });
}

export function createDidameshServer({ html, load = providerCatalog, logger = console }) {
  const getCatalog = catalogCache(load);
  const document = Buffer.from(html);
  const compressed = gzipSync(document);
  const policy = documentPolicy(html);

  const server = createServer({ headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 5_000 }, async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");

    function send(status, type, body) {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
      res.end(req.method === "HEAD" ? undefined : body);
    }
    function json(status, value) {
      send(status, "application/json; charset=utf-8", JSON.stringify(value));
    }

    const host = req.headers.host;
    if (!host || !HOST.test(host)) return json(403, { error: "host" });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return json(405, { error: "method" });
    }
    let url;
    let pathname;
    try {
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) return json(400, { error: "request" });
      url = new URL(req.url, `http://${host}`);
      if (url.host !== new URL(`http://${host}`).host) return json(400, { error: "request" });
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return json(400, { error: "request" });
    }

    if (pathname === "/" || pathname === "/didamesh (3).html") {
      res.setHeader("Content-Security-Policy", policy);
      res.setHeader("Vary", "Accept-Encoding");
      const gzip = acceptsGzip(req.headers["accept-encoding"]);
      if (gzip) res.setHeader("Content-Encoding", "gzip");
      return send(200, "text/html; charset=utf-8", gzip ? compressed : document);
    }
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (pathname === "/healthz") return json(200, { status: "ok" });
    if (pathname !== "/api/catalog") return json(404, { error: "not-found" });

    const fetchSite = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    if ((fetchSite && !["same-origin", "none"].includes(fetchSite)) || (origin && origin !== `http://${host}`)) {
      return json(403, { error: "origin" });
    }
    if (url.search.length > 2_000) return json(400, { error: "parameters" });
    const options = catalogOptions(url.searchParams);
    if (!options) return json(400, { error: "parameters" });

    try {
      return json(200, await getCatalog(options));
    } catch (error) {
      if (error instanceof CatalogBusy) {
        res.setHeader("Retry-After", "5");
        return json(503, { error: "catalog-busy" });
      }
      logger.warn("Catalog unavailable", error?.cause?.code ?? error?.name ?? "Error");
      return json(502, { error: "catalog-unavailable" });
    }
  });
  server.maxConnections = 128;
  return server;
}
