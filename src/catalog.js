import { normalizePoster, normalizeTitleData } from "./library.js";

export const CINEMETA_ORIGIN = "https://v3-cinemeta.strem.io";
export const CINEMETA_CATALOGS_ORIGIN = "https://cinemeta-catalogs.strem.io";
const IMDB_ORIGIN = "https://v3.sg.media-imdb.com";
const PAGE_SIZE = 50;
const LAST_OFFSET = 950;
const QUERY_LIMIT = 120;
const RESPONSE_LIMIT = 4 * 1024 * 1024;

export const GENRES = [
  ["", "همه ژانرها"], ["Action", "اکشن"], ["Comedy", "کمدی"], ["Drama", "درام"], ["Thriller", "دلهره‌آور"],
  ["Horror", "ترسناک"], ["Sci-Fi", "علمی‌تخیلی"], ["Animation", "انیمیشن"], ["Crime", "جنایی"],
  ["Romance", "عاشقانه"], ["Fantasy", "فانتزی"], ["Adventure", "ماجراجویی"], ["Mystery", "معمایی"],
  ["Documentary", "مستند"], ["War", "جنگی"], ["History", "تاریخی"],
];
const VALID_GENRES = new Set(GENRES.map(([value]) => value));
const PARAMS = new Set(["kind", "catalog", "genre", "q", "offset"]);

export function normalizeQuery(value) {
  return value.trim().replace(/\s+/gu, " ").normalize("NFC");
}

export function catalogOptions(params) {
  const seen = new Set();
  for (const key of params.keys()) {
    if (!PARAMS.has(key) || seen.has(key)) return null;
    seen.add(key);
  }
  const kind = params.get("kind") ?? "movie";
  const catalog = params.get("catalog") ?? "top";
  const genre = params.get("genre") ?? "";
  const q = normalizeQuery(params.get("q") ?? "");
  const rawOffset = params.get("offset") ?? "0";
  if (!["movie", "series"].includes(kind) || !["top", "imdbRating"].includes(catalog)) return null;
  if (!VALID_GENRES.has(genre) || q.length > QUERY_LIMIT || /[\p{Cc}\uFFFD]/u.test(q)) return null;
  if (!/^\d{1,3}$/u.test(rawOffset)) return null;
  const offset = Number(rawOffset);
  if (offset > LAST_OFFSET || offset % PAGE_SIZE !== 0 || (q && (genre || offset || catalog !== "top"))) return null;
  return { kind, catalog, genre, q, offset };
}

export function catalogParams({ kind, catalog, genre, q, offset = 0 }) {
  const params = new URLSearchParams({ kind, catalog, offset: String(offset) });
  if (q) params.set("q", q);
  if (genre) params.set("genre", genre);
  return params;
}

export function catalogItemKey(item) {
  return item.imdbId || JSON.stringify([item.kind, item.title, item.year]);
}

function unique(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = catalogItemKey(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

async function readJson(response) {
  if (!response.ok || !response.body) throw new Error("Catalog response failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("Catalog response is too large");
      }
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function getJson(url, fetcher, signal, timeout) {
  const deadline = AbortSignal.timeout(timeout);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return fetcher(url, { signal: requestSignal, redirect: "error", referrerPolicy: "no-referrer" }).then(readJson);
}

function releaseYear(value) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return String(value).match(/^\d{4}/u)?.[0];
}

function fromCinemeta(record, kind) {
  if (!record || typeof record !== "object") return null;
  const year = releaseYear(record.year) ?? releaseYear(record.releaseInfo);
  const genres = Array.isArray(record.genres) ? record.genres.filter((value) => typeof value === "string").slice(0, 3).join(", ") : record.genre;
  return normalizeTitleData({
    title: record.name, year, kind, genre: genres,
    imdbId: record.imdb_id || record.id, imdbRating: record.imdbRating,
    poster: normalizePoster(record.poster, { allowData: false }), overview: record.description,
  });
}

const IMDB_TYPES = new Map([["movie", "movie"], ["tvMovie", "movie"], ["tvSeries", "series"], ["tvMiniSeries", "series"]]);

async function imdbSuggestions({ q, kind }, fetcher, signal, timeout) {
  const term = q.toLowerCase();
  const first = /^[a-z0-9]/u.test(term) ? term[0] : "x";
  const url = `${IMDB_ORIGIN}/suggestion/${first}/${encodeURIComponent(term)}.json`;
  const data = await getJson(url, fetcher, signal, timeout);
  if (!data || (data.d !== undefined && !Array.isArray(data.d))) throw new Error("Invalid IMDb response");
  const items = (data.d ?? []).filter((row) => IMDB_TYPES.get(row?.qid) === kind).map((row) => normalizeTitleData({
    imdbId: row.id, title: row.l, year: row.y, kind, overview: row.s,
    poster: normalizePoster(row.i?.imageUrl, { allowData: false }),
  })).filter((item) => item?.imdbId);
  return { items: unique(items), nextOffset: null, source: "imdb" };
}

export async function providerCatalog(options, { fetcher = globalThis.fetch, signal, imdbFallback = true, timeout = 5_000 } = {}) {
  const { kind, catalog, genre, q, offset } = options;
  const extras = [];
  if (q) extras.push(`search=${encodeURIComponent(q)}`);
  if (genre) extras.push(`genre=${encodeURIComponent(genre)}`);
  if (offset) extras.push(`skip=${offset}`);
  const suffix = extras.length ? `/${extras.join("&")}` : "";
  const base = q ? CINEMETA_ORIGIN : `${CINEMETA_CATALOGS_ORIGIN}/${catalog}`;
  const url = `${base}/catalog/${kind}/${catalog}${suffix}.json`;
  let primary;
  try {
    const data = await getJson(url, fetcher, signal, timeout);
    if (!Array.isArray(data?.metas)) throw new Error("Invalid Cinemeta response");
    primary = {
      items: unique(data.metas.slice(0, PAGE_SIZE).map((row) => fromCinemeta(row, kind)).filter(Boolean)),
      // Cinemeta's skip indexes fixed windows of 50, even when a window returns fewer rows.
      nextOffset: !q && data.metas.length && offset < LAST_OFFSET ? offset + PAGE_SIZE : null,
      source: "cinemeta",
    };
    if (primary.items.length || !q || !imdbFallback) return primary;
  } catch (error) {
    if (!q || !imdbFallback || signal?.aborted) throw error;
  }
  try {
    const fallback = await imdbSuggestions(options, fetcher, signal, timeout);
    return fallback.items.length || !primary ? fallback : primary;
  } catch (error) {
    if (!primary || signal?.aborted) throw error;
    return primary;
  }
}

export async function fetchCatalog(criteria, signal) {
  const params = catalogParams(criteria);
  const options = catalogOptions(params);
  if (!options) throw new Error("Invalid catalog parameters");
  if (globalThis.location.protocol === "file:") return providerCatalog(options, { signal, imdbFallback: false });
  const url = `/api/catalog?${params}`;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const response = await fetch(url, { signal: deadline, referrerPolicy: "no-referrer" });
  if (response.status === 404) return providerCatalog(options, { signal, imdbFallback: false });
  const data = await readJson(response);
  const nextOffset = data?.nextOffset;
  if (!Array.isArray(data?.items) || (nextOffset !== null && nextOffset !== options.offset + PAGE_SIZE)) {
    throw new Error("Invalid catalog page");
  }
  return { ...data, items: unique(data.items.map(normalizeTitleData).filter(Boolean)) };
}
