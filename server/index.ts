import { readFile } from "node:fs/promises";
import { openDatabase } from "./db/connection.ts";
import { createDidameshServer } from "./http.ts";
import { createLibraryRepository } from "./library/repository.ts";

const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be between 1 and 65535.");

function connectionUrl(value: string | undefined) {
  if (!value) return undefined;
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (!url?.hostname || !["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  return value;
}

function applicationOrigin(value: string | undefined) {
  if (!value) return undefined;
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_ORIGIN must be an HTTP or HTTPS origin.");
  }
  return url;
}

const html = await readFile(new URL("../didamesh (3).html", import.meta.url), "utf8");
const publicOrigin = applicationOrigin(process.env.PUBLIC_ORIGIN);
const databaseUrl = connectionUrl(process.env.DATABASE_URL);
const database = databaseUrl ? openDatabase(databaseUrl) : undefined;
const app = createDidameshServer({
  html,
  publicOrigin,
  repository: database && createLibraryRepository(database.db),
  databaseReady: database?.isReady,
});
app.addHook("onClose", async () => { await database?.close(); });

try {
  const address = await app.listen({ port, host: "127.0.0.1" });
  console.log(`Didamesh is running at ${address}/`);
} catch (error) {
  console.error(`Didamesh could not listen on 127.0.0.1:${port}`, error instanceof Error ? error.name : "Error");
  await app.close();
  process.exitCode = 1;
}

async function shutdown() {
  try {
    await app.close();
  } catch {
    process.exitCode = 1;
  }
}
if (!process.exitCode) {
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
