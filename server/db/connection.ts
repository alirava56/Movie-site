import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema.ts";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export function openDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 3_000, statement_timeout: 5_000 });
  pool.on("error", (error) => console.warn("Idle database connection failed", error.name));
  const db: Database = drizzle(pool, { schema });

  return {
    db,
    async isReady() {
      const result = await pool.query<{ ready: boolean }>(`
        SELECT to_regclass('public.accounts') IS NOT NULL
          AND to_regclass('public.catalog_titles') IS NOT NULL
          AND to_regclass('public.library_items') IS NOT NULL
          AND to_regclass('public.library_request_keys') IS NOT NULL AS ready
      `);
      return result.rows[0]?.ready === true;
    },
    close: () => pool.end(),
  };
}

export function setAccountScope(accountId: string) {
  return sql`select set_config('didamesh.account_id', ${accountId}, true)`;
}
