import type { FastifyInstance, FastifyRequest } from "fastify";
import { LIMITS, normalizeDate, normalizePoster, searchKey } from "../../src/library.js";
import { HttpError } from "../http-error.ts";
import type { CatalogTitle, ItemChanges, ItemStatus, LibraryRepository, NewLibraryItem, PageCursor, TitleKind } from "./repository.ts";

export type ResolveAccountId = (request: FastifyRequest) => string | null | Promise<string | null>;

declare module "fastify" {
  interface FastifyRequest {
    didameshAccountId: string | null;
  }
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const DATE_PATTERN = "^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$";
const statusSchema = { type: "string", enum: ["watch", "watched"] };
const kindSchema = { type: "string", enum: ["movie", "series"] };
const dateSchema = { type: ["string", "null"], pattern: DATE_PATTERN };
const paramsSchema = { type: "object", required: ["id"], properties: { id: { type: "string", pattern: UUID_PATTERN } } };

type ItemParams = { id: string };
type CommonBody = { kind: TitleKind; status: ItemStatus; watchedAt?: string | null };
type CreateBody = CommonBody & (
  { source: "manual"; title: string; year?: number; poster?: string }
  | { source: "catalog"; imdbId: string }
);
type Filters = { status?: ItemStatus; kind?: TitleKind; q?: string; limit?: string; cursor?: string };

function validateDate(value: string | null | undefined) {
  if (value == null) return null;
  if (normalizeDate(value) !== value) throw new HttpError(400, "invalid-watched-date");
  return value;
}

function createInput(body: CreateBody): NewLibraryItem {
  const fields = { kind: body.kind, status: body.status, watchedAt: validateDate(body.watchedAt) };
  if (body.source === "catalog") return { source: "catalog", imdbId: body.imdbId, ...fields };

  const title = body.title.trim();
  const poster = normalizePoster(body.poster, { allowData: false });
  if (!searchKey(title) || title.includes("\0")) throw new HttpError(400, "invalid-title");
  if ((body.poster?.trim() && !poster) || poster.length > 2_048) throw new HttpError(400, "invalid-poster");
  return { source: "manual", title, year: body.year ?? null, poster, ...fields };
}

function readCursor(value: string | undefined): PageCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const [time, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof time !== "string" || typeof id !== "string" || !new RegExp(UUID_PATTERN, "u").test(id)) throw new Error();
    const addedAt = new Date(time);
    if (addedAt.toISOString() !== time) throw new Error();
    return { addedAt, id };
  } catch {
    throw new HttpError(400, "invalid-cursor");
  }
}

function readVersion(request: FastifyRequest) {
  const header = request.headers["if-match"];
  if (header === undefined) throw new HttpError(428, "version-required");
  const match = typeof header === "string" ? /^"([1-9][0-9]{0,9})"$/u.exec(header) : null;
  if (!match || Number(match[1]) > 2_147_483_647) throw new HttpError(400, "invalid-version");
  return Number(match[1]);
}

function requestKey(request: FastifyRequest) {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[\w-]{8,128}$/u.test(key)) throw new HttpError(400, "idempotency-key-required");
  return key;
}

function validAccountId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128 && id === id.trim() && !/\p{Cc}/u.test(id);
}

type Options = {
  repository?: LibraryRepository;
  resolveAccountId?: ResolveAccountId;
  loadTitle: (imdbId: string, kind: TitleKind) => Promise<CatalogTitle | null>;
};

export async function registerLibraryRoutes(app: FastifyInstance, { repository, resolveAccountId, loadTitle }: Options) {
  app.decorateRequest("didameshAccountId", null);
  app.addHook("onRequest", async (request) => {
    const id = await resolveAccountId?.(request);
    if (!validAccountId(id)) throw new HttpError(401, "account-required");
    if (!repository) throw new HttpError(503, "database-unavailable");
    request.didameshAccountId = id;
  });

  function context(request: FastifyRequest) {
    // Populated only by the server-side resolver before these handlers run.
    return { accountId: request.didameshAccountId!, library: repository! };
  }

  app.get<{ Querystring: Filters }>("/library", { schema: { querystring: {
    type: "object", additionalProperties: false, properties: {
      status: statusSchema, kind: kindSchema, q: { type: "string", maxLength: 120 },
      limit: { type: "string", pattern: "^(?:[1-9]|[1-4][0-9]|50)$" },
      cursor: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9_-]+$" },
    },
  } } }, async (request) => {
    const { accountId, library } = context(request);
    const { status, kind, q, limit, cursor } = request.query;
    if (q?.includes("\0")) throw new HttpError(400, "invalid-search");
    const { items, next } = await library.list(accountId, { status, kind, q, limit: Number(limit ?? 25), before: readCursor(cursor) });
    const nextCursor = next ? Buffer.from(JSON.stringify([next.addedAt, next.id])).toString("base64url") : null;
    return { items, nextCursor };
  });

  app.post<{ Body: CreateBody }>("/library", { schema: { body: { oneOf: [
    {
      type: "object", additionalProperties: false, required: ["source", "status", "kind", "title"], properties: {
        source: { const: "manual" }, status: statusSchema, kind: kindSchema, watchedAt: dateSchema,
        title: { type: "string", minLength: 1, maxLength: LIMITS.title },
        year: { type: "integer", minimum: 1000, maximum: 9999 }, poster: { type: "string", maxLength: 2_048 },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["source", "status", "kind", "imdbId"], properties: {
        source: { const: "catalog" }, status: statusSchema, kind: kindSchema, watchedAt: dateSchema,
        imdbId: { type: "string", pattern: "^tt[0-9]{7,12}$" },
      },
    },
  ] } } }, async (request, reply) => {
    const { accountId, library } = context(request);
    const { item, created } = await library.create(accountId, requestKey(request), createInput(request.body), loadTitle);
    return reply.code(created ? 201 : 200).header("ETag", `"${item.version}"`).send(item);
  });

  app.get<{ Params: ItemParams }>("/library/:id", { schema: { params: paramsSchema } }, async (request, reply) => {
    const { accountId, library } = context(request);
    const item = await library.get(accountId, request.params.id);
    return reply.header("ETag", `"${item.version}"`).send(item);
  });

  app.patch<{ Params: ItemParams; Body: ItemChanges }>("/library/:id", { schema: {
    params: paramsSchema,
    body: { type: "object", additionalProperties: false, minProperties: 1, properties: {
      status: statusSchema, watchedAt: dateSchema, myRating: { type: ["integer", "null"], minimum: 1, maximum: 5 },
      note: { type: "string", maxLength: LIMITS.note },
    } },
  } }, async (request, reply) => {
    const { accountId, library } = context(request);
    const changes = { ...request.body };
    if (changes.watchedAt !== undefined) changes.watchedAt = validateDate(changes.watchedAt);
    if (changes.note?.includes("\0")) throw new HttpError(400, "invalid-note");
    const item = await library.update(accountId, request.params.id, readVersion(request), changes);
    return reply.header("ETag", `"${item.version}"`).send(item);
  });

  app.delete<{ Params: ItemParams }>("/library/:id", { schema: { params: paramsSchema } }, async (request, reply) => {
    const { accountId, library } = context(request);
    await library.remove(accountId, request.params.id, readVersion(request));
    return reply.code(204).send();
  });
}
