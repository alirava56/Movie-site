import { CINEMETA_ORIGIN, fromCinemeta, providerCatalog, readJson } from "../src/catalog.js";
import type { catalogOptions } from "../src/catalog.js";
import { HttpError } from "./http-error.ts";
import type { CatalogTitle, TitleKind } from "./library/repository.ts";

const CACHE_LIFETIME = 120_000;
const CACHE_SIZE = 96;
const MAX_CONCURRENT = 12;

type CatalogOptions = NonNullable<ReturnType<typeof catalogOptions>>;
type CatalogPage = Awaited<ReturnType<typeof providerCatalog>>;
export type CatalogLoader = (options: CatalogOptions) => Promise<CatalogPage>;

async function loadCinemetaTitle(imdbId: string, kind: TitleKind) {
  const response = await fetch(`${CINEMETA_ORIGIN}/meta/${kind}/${imdbId}.json`, {
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) return null;
  const data = await readJson(response);
  if (data?.meta?.type && data.meta.type !== kind) return null;
  const title = fromCinemeta(data?.meta, kind);
  return title?.imdbId === imdbId ? title : null;
}

export function createCatalogService(load: CatalogLoader = providerCatalog) {
  const stored = new Map<string, { page: CatalogPage; expires: number }>();
  const pending = new Map<string, Promise<CatalogPage>>();
  const titleLoads = new Map<string, Promise<CatalogTitle | null>>();

  function checkCapacity() {
    if (pending.size + titleLoads.size >= MAX_CONCURRENT) throw new HttpError(503, "catalog-busy");
  }

  return {
    async getPage(options: CatalogOptions) {
      const key = JSON.stringify(options);
      const cached = stored.get(key);
      if (cached) {
        stored.delete(key);
        if (cached.expires > Date.now()) {
          stored.set(key, cached);
          return cached.page;
        }
      }
      const pendingPage = pending.get(key);
      if (pendingPage) return pendingPage;
      checkCapacity();

      const request = Promise.resolve().then(() => load(options)).then((page) => {
        const oldest = stored.keys().next().value;
        if (stored.size >= CACHE_SIZE && oldest !== undefined) stored.delete(oldest);
        stored.set(key, { page, expires: Date.now() + CACHE_LIFETIME });
        return page;
      });
      pending.set(key, request);
      try {
        return await request;
      } finally {
        pending.delete(key);
      }
    },

    async getTitle(imdbId: string, kind: TitleKind) {
      if (!/^tt\d{7,12}$/u.test(imdbId)) return null;
      for (const { page, expires } of stored.values()) {
        if (expires <= Date.now()) continue;
        const match = page.items.find((item) => item.imdbId === imdbId && item.kind === kind);
        if (match) return match;
      }

      const key = `${kind}:${imdbId}`;
      const pendingTitle = titleLoads.get(key);
      if (pendingTitle) return pendingTitle;
      checkCapacity();
      const request = loadCinemetaTitle(imdbId, kind).catch(() => {
        throw new HttpError(502, "catalog-unavailable");
      });
      titleLoads.set(key, request);
      try {
        return await request;
      } finally {
        titleLoads.delete(key);
      }
    },
  };
}
