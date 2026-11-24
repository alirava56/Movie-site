import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createDidameshServer } from "../server/http.ts";
import { setAccountScope } from "../server/db/connection.ts";
import { createLibraryRepository } from "../server/library/repository.ts";
import { libraryItems } from "../server/db/schema.ts";

const html = await readFile(new URL("../didamesh (3).html", import.meta.url), "utf8");
const migrationsFolder = fileURLToPath(new URL("../server/db/migrations/", import.meta.url));
const manual = { source: "manual", title: "يك فيلم", kind: "movie", status: "watch", year: 2022 };
const arrival = { imdbId: "tt2543164", title: "Arrival", kind: "movie", year: "2016", poster: "", genre: "Sci-Fi", overview: "", imdbRating: 7.9 };

test("private routes require a server-side account resolver", async (t) => {
  const app = createDidameshServer({ html });
  t.after(() => app.close());
  const headers = { host: "localhost:4173", origin: "http://localhost:4173", "x-user-id": "alice" };
  const privateResponse = await app.inject({ url: "/api/v1/library", headers });
  assert.equal(privateResponse.statusCode, 401);
  assert.equal(privateResponse.json().error, "account-required");
  const write = await app.inject({ method: "POST", url: "/api/v1/library", headers, payload: manual });
  assert.equal(write.statusCode, 401);
  const readiness = await app.inject({ url: "/readyz", headers });
  assert.equal(readiness.statusCode, 503);
});

test("migrated PostgreSQL library API enforces ownership and write consistency", async (t) => {
  const client = new PGlite();
  t.after(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder });
  await client.exec(`
    INSERT INTO accounts (id) VALUES ('alice'), ('bob');
    CREATE ROLE didamesh_test_runtime;
    GRANT SELECT ON accounts TO didamesh_test_runtime;
    GRANT SELECT, INSERT ON catalog_titles TO didamesh_test_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON library_items, library_request_keys TO didamesh_test_runtime;
    SET ROLE didamesh_test_runtime;
  `);

  const loginFixtures = new Map([["Bearer test-alice", "alice"], ["Bearer test-bob", "bob"]]);
  const app = createDidameshServer({
    html, repository: createLibraryRepository(db),
    resolveAccountId: ({ headers }) => loginFixtures.get(headers.authorization) ?? null,
    load: async () => ({ items: [arrival], nextOffset: null, source: "cinemeta" }),
  });
  t.after(() => app.close());

  function send(method, url, { account = "alice", payload, headers } = {}) {
    return app.inject({ method, url, payload, headers: {
      host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173", authorization: `Bearer test-${account}`, ...headers,
    } });
  }
  function add(payload, key, account) {
    return send("POST", "/api/v1/library", { account, payload, headers: { "idempotency-key": key } });
  }

  let aliceId;
  await t.test("authorized requests validate data and retries create one owned item", async () => {
    const foreignOrigin = await send("POST", "/api/v1/library", { payload: manual, headers: { origin: "https://example.com" } });
    assert.equal(foreignOrigin.statusCode, 403);
    const injectedOwner = await add({ ...manual, accountId: "bob" }, "wrong-owner", "alice");
    assert.equal(injectedOwner.statusCode, 400);
    const wrongDate = await add({ ...manual, watchedAt: "2025-02-30" }, "wrong-date", "alice");
    assert.equal(wrongDate.statusCode, 400);

    const writes = await Promise.all([add(manual, "same-request"), add(manual, "same-request")]);
    assert.deepEqual(writes.map((response) => response.statusCode).sort(), [200, 201]);
    aliceId = writes[0].json().id;
    assert.equal(writes[1].json().id, aliceId);
    assert.equal(Object.hasOwn(writes[0].json(), "accountId"), false);
    assert.equal((await add({ ...manual, title: "Other title" }, "same-request")).statusCode, 409);
    const other = await add(manual, "same-request", "bob");
    assert.equal(other.statusCode, 201);
    assert.notEqual(other.json().id, aliceId);
    const alice = await send("GET", "/api/v1/library?q=" + encodeURIComponent("یک فیلم"));
    assert.deepEqual(alice.json().items.map(({ id }) => id), [aliceId]);
    const bob = await send("GET", "/api/v1/library", { account: "bob" });
    assert.deepEqual(bob.json().items.map(({ id }) => id), [other.json().id]);
    assert.equal((await send("GET", `/api/v1/library/${aliceId}`, { account: "bob" })).statusCode, 404);
    assert.deepEqual(await db.select().from(libraryItems), []);
  });

  await t.test("concurrent edits are conditional and deleting an item does not resurrect a retry", async () => {
    const path = `/api/v1/library/${aliceId}`;
    const denied = await send("DELETE", path, { account: "bob", headers: { "if-match": '"1"' } });
    assert.equal(denied.statusCode, 404);
    assert.equal((await send("PATCH", path, { payload: { note: "یادداشت" } })).statusCode, 428);
    const changed = await send("PATCH", path, { payload: { status: "watched", myRating: 5, watchedAt: "2024-02-29", note: "دیده شد" }, headers: { "if-match": '"1"' } });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.headers.etag, '"2"');
    assert.equal(changed.json().watchedAt, "2024-02-29");
    const stale = await send("PATCH", path, { payload: { note: "نسخه قدیمی" }, headers: { "if-match": '"1"' } });
    assert.equal(stale.statusCode, 412);
    assert.equal((await send("GET", path)).json().note, "دیده شد");
    assert.equal((await send("DELETE", path, { headers: { "if-match": '"2"' } })).statusCode, 204);
    assert.equal((await add(manual, "same-request")).statusCode, 410);
  });

  await t.test("catalog identity deduplicates within an account and pagination keeps timestamp ties", async () => {
    assert.equal((await send("GET", "/api/catalog?kind=movie")).statusCode, 200);
    const body = { source: "catalog", imdbId: arrival.imdbId, kind: "movie", status: "watch" };
    const first = await add(body, "arrival-first");
    assert.equal(first.statusCode, 201);
    const duplicate = await add({ ...body, status: "watched" }, "arrival-duplicate");
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().id, first.json().id);
    assert.equal(duplicate.json().status, "watch");
    assert.ok(Math.abs(duplicate.json().imdbRating - 7.9) < 0.01);
    assert.equal((await add(body, "arrival-first", "bob")).statusCode, 201);
    const other = await add({ ...manual, title: "Movie two" }, "new-manual-item");
    assert.equal(other.statusCode, 201);
    await db.transaction(async (tx) => {
      await tx.execute(setAccountScope("alice"));
      await tx.update(libraryItems).set({ addedAt: sql`'2026-11-24T09:30:00.123400Z'::timestamptz` }).where(eq(libraryItems.id, first.json().id));
      await tx.update(libraryItems).set({ addedAt: sql`'2026-11-24T09:30:00.123100Z'::timestamptz` }).where(eq(libraryItems.id, other.json().id));
    });
    const page1 = (await send("GET", "/api/v1/library?limit=1")).json();
    assert.ok(page1.nextCursor);
    const page2 = (await send("GET", `/api/v1/library?limit=1&cursor=${page1.nextCursor}`)).json();
    assert.equal(page2.nextCursor, null);
    const ids = [...page1.items, ...page2.items].map(({ id }) => id).sort();
    assert.deepEqual(ids, [first.json().id, other.json().id].sort());
  });
});
