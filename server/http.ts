import { gzipSync } from "node:zlib";
import Fastify from "fastify";
import type { FastifyError, FastifyRequest, RouteHandlerMethod } from "fastify";
import { catalogOptions } from "../src/catalog.js";
import { createCatalogService } from "./catalog.ts";
import type { CatalogLoader } from "./catalog.ts";
import { HttpError } from "./http-error.ts";
import { registerLibraryRoutes } from "./library/routes.ts";
import type { ResolveAccountId } from "./library/routes.ts";
import type { LibraryRepository } from "./library/repository.ts";
import { documentPolicy } from "./policy.js";

const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/iu;
const GET_PATHS = new Set(["/", "/didamesh (3).html", "/favicon.ico", "/healthz", "/readyz", "/api/catalog"]);

function originForRequest(host: string | undefined, publicOrigin: URL | undefined) {
  if (!host) throw new HttpError(403, "host");
  if (publicOrigin) {
    if (host.toLowerCase() !== publicOrigin.host) throw new HttpError(403, "host");
    return publicOrigin.origin;
  }
  if (!LOCAL_HOST.test(host)) throw new HttpError(403, "host");
  try {
    return new URL(`http://${host}`).origin;
  } catch {
    throw new HttpError(403, "host");
  }
}

function requestUrl(request: FastifyRequest, origin: string) {
  try {
    const path = request.raw.url;
    if (!path?.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error();
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error();
    return url;
  } catch {
    throw new HttpError(400, "request");
  }
}

function acceptsGzip(header: unknown) {
  return typeof header === "string" && header.split(",").some((token) => {
    const [name, quality] = token.trim().toLowerCase().split(/\s*;\s*/u);
    return name === "gzip" && (!quality || (quality.startsWith("q=") && Number(quality.slice(2)) > 0));
  });
}

type Options = {
  html: string;
  load?: CatalogLoader;
  repository?: LibraryRepository;
  resolveAccountId?: ResolveAccountId;
  databaseReady?: () => Promise<boolean>;
  publicOrigin?: URL;
  logger?: { warn: (...args: unknown[]) => void };
};

export function createDidameshServer({ html, load, repository, resolveAccountId, databaseReady, publicOrigin, logger = console }: Options) {
  const app = Fastify({
    bodyLimit: 128 * 1024,
    requestTimeout: 15_000,
    keepAliveTimeout: 5_000,
    routerOptions: { maxParamLength: 128 },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.server.headersTimeout = 10_000;
  app.server.maxConnections = 128;
  const catalog = createCatalogService(load);
  const document = Buffer.from(html);
  const compressed = gzipSync(document);
  const policy = documentPolicy(html);

  app.addHook("onRequest", async (request, reply) => {
    reply.headers({
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "no-store",
    });

    const origin = originForRequest(request.headers.host, publicOrigin);
    const url = requestUrl(request, origin);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, "request");
    }
    const read = request.method === "GET" || request.method === "HEAD";
    if (GET_PATHS.has(pathname) && !read) {
      reply.header("Allow", "GET, HEAD");
      throw new HttpError(405, "method");
    }
    const privateRoute = pathname.startsWith("/api/v1/");
    if (pathname === "/api/catalog" || privateRoute) {
      const site = request.headers["sec-fetch-site"];
      const sentOrigin = request.headers.origin;
      if ((site && !["same-origin", "none"].includes(String(site))) ||
          (sentOrigin !== undefined && sentOrigin !== origin) || (privateRoute && !read && !sentOrigin)) {
        throw new HttpError(403, "origin");
      }
    }
  });

  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof HttpError) {
      if (error.code === "catalog-busy") reply.header("Retry-After", "5");
      return reply.code(error.status).send({ error: error.code });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.validation ? "invalid-input" : "invalid-request" });
    }
    const databaseFailure = error.name === "DrizzleQueryError";
    // Driver errors may contain SQL parameters and user data.
    logger.warn("Request failed", error.name);
    return reply.code(databaseFailure ? 503 : 500).send({ error: databaseFailure ? "database-unavailable" : "internal-error" });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not-found" }));
  const serveDocument: RouteHandlerMethod = (request, reply) => {
    reply.header("Content-Security-Policy", policy).header("Vary", "Accept-Encoding");
    const gzip = acceptsGzip(request.headers["accept-encoding"]);
    if (gzip) reply.header("Content-Encoding", "gzip");
    return reply.type("text/html; charset=utf-8").send(gzip ? compressed : document);
  };
  app.get("/", serveDocument);
  app.get("/didamesh (3).html", serveDocument);
  app.get("/favicon.ico", (_request, reply) => reply.code(204).send());
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      if (await databaseReady?.()) return { status: "ready" };
    } catch {
      // Keep database connection details out of the health response.
    }
    return reply.code(503).send({ status: "unavailable" });
  });

  app.get("/api/catalog", async (request) => {
    const url = requestUrl(request, originForRequest(request.headers.host, publicOrigin));
    if (url.search.length > 2_000) throw new HttpError(400, "parameters");
    const options = catalogOptions(url.searchParams);
    if (!options) throw new HttpError(400, "parameters");
    try {
      return await catalog.getPage(options);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      logger.warn("Catalog unavailable", error instanceof Error ? error.name : "Error");
      throw new HttpError(502, "catalog-unavailable");
    }
  });

  app.register(registerLibraryRoutes, { prefix: "/api/v1", repository, resolveAccountId, loadTitle: catalog.getTitle });
  return app;
}
