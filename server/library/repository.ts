import { createHash } from "node:crypto";
import { and, count, desc, eq, lt, or, sql } from "drizzle-orm";
import { LIMITS, searchKey } from "../../src/library.js";
import type { normalizeTitleData } from "../../src/library.js";
import type { Database } from "../db/connection.ts";
import { setAccountScope } from "../db/connection.ts";
import { accounts, catalogTitles, libraryItems, libraryRequestKeys } from "../db/schema.ts";
import { HttpError } from "../http-error.ts";

export type TitleKind = typeof catalogTitles.$inferSelect.kind;
export type ItemStatus = typeof libraryItems.$inferSelect.status;
export type CatalogTitle = NonNullable<ReturnType<typeof normalizeTitleData>>;

type NewItemFields = { status: ItemStatus; watchedAt: string | null };
export type NewLibraryItem = NewItemFields & (
  { source: "manual"; title: string; kind: TitleKind; year: number | null; poster: string }
  | { source: "catalog"; imdbId: string; kind: TitleKind }
);

export type ItemChanges = Partial<Pick<typeof libraryItems.$inferSelect, "status" | "watchedAt" | "myRating" | "note">>;
export type PageCursor = { addedAt: Date; id: string };
export type LibraryFilter = { status?: ItemStatus; kind?: TitleKind; q?: string; limit: number; before?: PageCursor };

type ItemRow = typeof libraryItems.$inferSelect;
type CatalogRow = typeof catalogTitles.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function itemView(item: ItemRow, catalog: CatalogRow | null) {
  const { accountId, searchTitle, ...publicFields } = item;
  return {
    ...publicFields,
    genre: catalog?.genre ?? "",
    overview: catalog?.overview ?? "",
    imdbRating: catalog?.imdbRating ?? null,
  };
}

async function readItem(tx: Transaction, accountId: string, id: string) {
  const [row] = await tx.select({ item: libraryItems, catalog: catalogTitles }).from(libraryItems)
    .leftJoin(catalogTitles, eq(libraryItems.imdbId, catalogTitles.imdbId))
    .where(and(eq(libraryItems.accountId, accountId), eq(libraryItems.id, id))).limit(1);
  return row ? itemView(row.item, row.catalog) : null;
}

async function mustReadItem(tx: Transaction, accountId: string, id: string) {
  const item = await readItem(tx, accountId, id);
  if (!item) throw new HttpError(404, "library-item-not-found");
  return item;
}

async function readCatalogTitle(db: Pick<Database, "select">, imdbId: string) {
  const [title] = await db.select().from(catalogTitles).where(eq(catalogTitles.imdbId, imdbId)).limit(1);
  return title;
}

export function createLibraryRepository(db: Database) {
  function scoped<T>(accountId: string, run: (tx: Transaction) => Promise<T>) {
    return db.transaction(async (tx) => {
      await tx.execute(setAccountScope(accountId));
      const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (!account) throw new HttpError(403, "account-not-provisioned");
      return run(tx);
    });
  }

  return {
    list(accountId: string, { status, kind, q, limit, before }: LibraryFilter) {
      return scoped(accountId, async (tx) => {
        const term = q && searchKey(q);
        const rows = await tx.select({ item: libraryItems, catalog: catalogTitles }).from(libraryItems)
          .leftJoin(catalogTitles, eq(libraryItems.imdbId, catalogTitles.imdbId))
          .where(and(
            eq(libraryItems.accountId, accountId),
            status ? eq(libraryItems.status, status) : undefined,
            kind ? eq(libraryItems.kind, kind) : undefined,
            term ? sql`strpos(${libraryItems.searchTitle}, ${term}) > 0` : undefined,
            before ? or(
              lt(libraryItems.addedAt, before.addedAt),
              and(eq(libraryItems.addedAt, before.addedAt), lt(libraryItems.id, before.id)),
            ) : undefined,
          ))
          .orderBy(desc(libraryItems.addedAt), desc(libraryItems.id)).limit(limit + 1);
        const items = rows.slice(0, limit).map((row) => itemView(row.item, row.catalog));
        const last = items.at(-1);
        const next = rows.length > limit && last ? { addedAt: last.addedAt, id: last.id } : null;
        return { items, next };
      });
    },

    get(accountId: string, id: string) {
      return scoped(accountId, (tx) => mustReadItem(tx, accountId, id));
    },

    async create(
      accountId: string,
      key: string,
      input: NewLibraryItem,
      loadTitle: (imdbId: string, kind: TitleKind) => Promise<CatalogTitle | null>,
    ) {
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const needsTitle = input.source === "catalog" && !await readCatalogTitle(db, input.imdbId);
      // Network I/O stays outside the transaction and its account lock.
      const fetchedTitle = needsTitle && input.source === "catalog" ? await loadTitle(input.imdbId, input.kind) : null;

      return scoped(accountId, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`);
        await tx.delete(libraryRequestKeys).where(and(eq(libraryRequestKeys.accountId, accountId),
          sql`${libraryRequestKeys.createdAt} < now() - interval '24 hours'`));
        const [prior] = await tx.select().from(libraryRequestKeys).where(and(
          eq(libraryRequestKeys.accountId, accountId), eq(libraryRequestKeys.key, key),
        )).limit(1);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new HttpError(409, "idempotency-key-reused");
          const item = await readItem(tx, accountId, prior.itemId);
          if (!item) throw new HttpError(410, "library-item-removed");
          return { item, created: false };
        }

        let catalog: CatalogRow | undefined;
        if (input.source === "catalog") {
          catalog = await readCatalogTitle(tx, input.imdbId);
          if (!catalog && fetchedTitle?.imdbId === input.imdbId && fetchedTitle.kind === input.kind) {
            await tx.insert(catalogTitles).values({
              imdbId: input.imdbId, kind: input.kind, title: fetchedTitle.title,
              year: fetchedTitle.year ? Number(fetchedTitle.year) : null, poster: fetchedTitle.poster,
              genre: fetchedTitle.genre, overview: fetchedTitle.overview, imdbRating: fetchedTitle.imdbRating,
            }).onConflictDoNothing();
            catalog = await readCatalogTitle(tx, input.imdbId);
          }
          if (!catalog || catalog.kind !== input.kind) throw new HttpError(404, "catalog-title-not-found");

          const [existing] = await tx.select({ id: libraryItems.id }).from(libraryItems).where(and(
            eq(libraryItems.accountId, accountId), eq(libraryItems.imdbId, catalog.imdbId),
          )).limit(1);
          if (existing) {
            await tx.insert(libraryRequestKeys).values({ accountId, key, fingerprint, itemId: existing.id });
            return { item: await mustReadItem(tx, accountId, existing.id), created: false };
          }
        }

        const [total] = await tx.select({ count: count() }).from(libraryItems).where(eq(libraryItems.accountId, accountId));
        if (total.count >= LIMITS.items) throw new HttpError(409, "library-capacity");
        const media = input.source === "manual" ? input : catalog!;
        const [inserted] = await tx.insert(libraryItems).values({
          accountId, imdbId: catalog?.imdbId ?? null, title: media.title, searchTitle: searchKey(media.title),
          kind: media.kind, year: media.year, poster: media.poster, status: input.status, watchedAt: input.watchedAt,
        }).returning();
        await tx.insert(libraryRequestKeys).values({ accountId, key, fingerprint, itemId: inserted.id });
        return { item: itemView(inserted, catalog ?? null), created: true };
      });
    },

    update(accountId: string, id: string, version: number, changes: ItemChanges) {
      return scoped(accountId, async (tx) => {
        const [changed] = await tx.update(libraryItems).set({
          ...changes, updatedAt: sql`now()`, version: sql`${libraryItems.version} + 1`,
        }).where(and(eq(libraryItems.accountId, accountId), eq(libraryItems.id, id), eq(libraryItems.version, version)))
          .returning({ id: libraryItems.id });
        const item = await mustReadItem(tx, accountId, id);
        if (!changed) throw new HttpError(412, "library-version-conflict");
        return item;
      });
    },

    remove(accountId: string, id: string, version: number) {
      return scoped(accountId, async (tx) => {
        const [deleted] = await tx.delete(libraryItems).where(and(
          eq(libraryItems.accountId, accountId), eq(libraryItems.id, id), eq(libraryItems.version, version),
        )).returning({ id: libraryItems.id });
        if (deleted) return;
        await mustReadItem(tx, accountId, id);
        throw new HttpError(412, "library-version-conflict");
      });
    },
  };
}

export type LibraryRepository = ReturnType<typeof createLibraryRepository>;
