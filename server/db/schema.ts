import { sql } from "drizzle-orm";
import {
  check, date, index, integer, pgEnum, pgPolicy, pgTable, primaryKey, real, smallint, text,
  timestamp, unique, uuid, varchar,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { LIMITS } from "../../src/library.js";

export const mediaKind = pgEnum("media_kind", ["movie", "series"]);
export const libraryStatus = pgEnum("library_status", ["watch", "watched"]);

function ownerPolicy(column: AnyPgColumn) {
  const ownsRow = sql`${column} = nullif(current_setting('didamesh.account_id', true), '')`;
  return pgPolicy("account_owns_row", { for: "all", to: "public", using: ownsRow, withCheck: ownsRow });
}

export const accounts = pgTable("accounts", {
  id: varchar("id", { length: 128 }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [ownerPolicy(table.id)]).enableRLS();

export const catalogTitles = pgTable("catalog_titles", {
  imdbId: varchar("imdb_id", { length: 14 }).primaryKey(),
  title: varchar("title", { length: LIMITS.title }).notNull(),
  kind: mediaKind("kind").notNull(),
  year: smallint("year"),
  poster: varchar("poster", { length: 2_048 }).notNull().default(""),
  genre: varchar("genre", { length: 200 }).notNull().default(""),
  overview: varchar("overview", { length: 2_000 }).notNull().default(""),
  imdbRating: real("imdb_rating"),
}, (table) => [
  check("catalog_imdb_id_format", sql`${table.imdbId} ~ '^tt[0-9]{7,12}$'`),
  check("catalog_year_range", sql`${table.year} between 1000 and 9999`),
  check("catalog_rating_range", sql`${table.imdbRating} between 0 and 10`),
]);

export const libraryItems = pgTable("library_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: varchar("account_id", { length: 128 }).notNull().references(() => accounts.id, { onDelete: "cascade" }),
  imdbId: varchar("imdb_id", { length: 14 }).references(() => catalogTitles.imdbId),
  title: varchar("title", { length: LIMITS.title }).notNull(),
  searchTitle: text("search_title").notNull(),
  kind: mediaKind("kind").notNull(),
  year: smallint("year"),
  poster: varchar("poster", { length: 2_048 }).notNull().default(""),
  status: libraryStatus("status").notNull(),
  myRating: smallint("my_rating"),
  watchedAt: date("watched_at"),
  note: varchar("note", { length: LIMITS.note }).notNull().default(""),
  version: integer("version").notNull().default(1),
  addedAt: timestamp("added_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  unique("library_account_imdb_unique").on(table.accountId, table.imdbId),
  index("library_account_recent").on(table.accountId, table.addedAt.desc(), table.id.desc()),
  check("library_year_range", sql`${table.year} between 1000 and 9999`),
  check("library_rating_range", sql`${table.myRating} between 1 and 5`),
  check("library_version_positive", sql`${table.version} > 0`),
  ownerPolicy(table.accountId),
]).enableRLS();

export const libraryRequestKeys = pgTable("library_request_keys", {
  accountId: varchar("account_id", { length: 128 }).notNull().references(() => accounts.id, { onDelete: "cascade" }),
  key: varchar("request_key", { length: 128 }).notNull(),
  fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
  itemId: uuid("item_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.key] }),
  index("library_request_age").on(table.accountId, table.createdAt),
  ownerPolicy(table.accountId),
]).enableRLS();
