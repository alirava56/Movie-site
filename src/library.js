export const LIMITS = Object.freeze({
  title: 300,
  note: 16_000,
  imageFile: 8 * 1024 * 1024,
  imagePixels: 24_000_000,
  posterData: 320_000,
  items: 3_000,
  backup: 24 * 1024 * 1024,
});

const BACKUP_VERSION = 2;
const ITEM_ID = /^[\w-]{1,100}$/u;
const IMDB_ID = /^tt\d{7,12}$/u;
const POSTER_DATA = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;
const encoder = new TextEncoder();

export class LibraryError extends Error {
  constructor(code) {
    super(code);
    this.name = "LibraryError";
    this.code = code;
  }
}

export function latinDigits(value) {
  return value.replace(/[۰-۹٠-٩]/gu, (digit) => String(digit.charCodeAt(0) & 15));
}

function comparableTitle(value) {
  return latinDigits(value)
    .normalize("NFKC")
    .replace(/[يى]/gu, "ی")
    .replace(/ك/gu, "ک")
    .replace(/[\u0640\u200c\u200d]/gu, "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

export function searchKey(value) {
  return comparableTitle(value).normalize("NFD").replace(/\p{M}/gu, "");
}

export function normalizeYear(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const normalized = latinDigits(String(value).trim());
  return /^[1-9]\d{3}$/u.test(normalized) ? normalized : "";
}

export function localDate(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function normalizeDate(value) {
  if (typeof value !== "string") return "";
  const date = latinDigits(value.trim());
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/u.test(date)) return "";
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : "";
}

export function normalizePoster(value, { allowData = true } = {}) {
  if (typeof value !== "string") return "";
  const poster = value.trim();
  if (!poster) return "";
  if (allowData && poster.length <= LIMITS.posterData && POSTER_DATA.test(poster)) return poster;
  if (poster.length > 2_048 || !/^https:\/\//iu.test(poster) || /[\s\u0000-\u001f]/u.test(poster)) return "";
  try {
    const url = new URL(poster);
    return url.hostname && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function text(value, limit, trim = true) {
  if (typeof value !== "string") return "";
  return (trim ? value.trim() : value).slice(0, limit);
}

function rating(value, max, fallback) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") return fallback;
  const number = Number(latinDigits(String(value)));
  return Number.isFinite(number) && number >= 0 && number <= max ? number : fallback;
}

export function normalizeTitleData(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const title = text(input.title, LIMITS.title);
  if (!searchKey(title)) return null;
  return {
    title,
    year: normalizeYear(input.year),
    kind: input.kind === "series" ? "series" : "movie",
    imdbId: typeof input.imdbId === "string" && IMDB_ID.test(input.imdbId) ? input.imdbId : "",
    poster: normalizePoster(input.poster),
    genre: text(input.genre, 200),
    overview: text(input.overview, 2_000),
    imdbRating: rating(input.imdbRating, 10, null),
  };
}

function normalizeItem(input) {
  const titleData = normalizeTitleData(input);
  if (!titleData) return null;
  const addedAt = typeof input.addedAt === "number" && Number.isSafeInteger(input.addedAt) && input.addedAt >= 0
    ? input.addedAt
    : 0;
  return {
    id: typeof input.id === "string" && ITEM_ID.test(input.id) ? input.id : "",
    ...titleData,
    status: input.status === "watched" ? "watched" : "watch",
    myRating: Math.trunc(rating(input.myRating, 5, 0)),
    watchedAt: normalizeDate(input.watchedAt),
    note: text(input.note, LIMITS.note, false),
    addedAt,
  };
}

function titleIdentity(item) {
  return JSON.stringify([item.kind, item.year, comparableTitle(item.title)]);
}

export function indexTitles(items) {
  const byExternalId = new Map();
  const byTitle = new Map();
  function add(item) {
    if (item.imdbId) byExternalId.set(item.imdbId, item);
    const key = titleIdentity(item);
    const matches = byTitle.get(key) ?? [];
    matches.push(item);
    byTitle.set(key, matches);
  }
  for (const item of items) add(item);
  return {
    add,
    find(item) {
      const exact = byExternalId.get(item.imdbId);
      if (exact) return exact;
      const matches = byTitle.get(titleIdentity(item)) ?? [];
      // Distinct IMDb titles can share a name, year and kind.
      if (item.imdbId) return matches.find((match) => !match.imdbId);
      return matches.length === 1 ? matches[0] : undefined;
    },
  };
}

export function parseBackup(raw) {
  if (typeof raw !== "string" || raw.length > LIMITS.backup || encoder.encode(raw).length > LIMITS.backup) {
    throw new LibraryError("backup-size");
  }
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch {
    throw new LibraryError("backup-format");
  }
  if (data?.v !== undefined && data.v !== 1 && data.v !== BACKUP_VERSION) throw new LibraryError("backup-version");
  const input = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(input)) throw new LibraryError("backup-format");
  if (input.length > LIMITS.items) throw new LibraryError("library-size");

  const items = [];
  let skipped = 0;
  let repaired = 0;
  for (const record of input) {
    const item = normalizeItem(record);
    if (!item) {
      skipped++;
      continue;
    }
    if (Object.keys(item).some((key) => {
      const previous = record[key];
      if (previous === undefined || previous === item[key]) return false;
      return key !== "year" || !item.year || normalizeYear(previous) !== item.year;
    })) repaired++;
    items.push(item);
  }
  return { items, skipped, repaired };
}

export function serializeBackup(items) {
  return JSON.stringify({ v: BACKUP_VERSION, items });
}

export function checkLibraryCapacity(current, changes) {
  const replacements = new Map(changes.put.map((item) => [item.id, item]));
  const removed = new Set(changes.remove);
  let bytes = encoder.encode(serializeBackup([])).length;
  let count = 0;
  function countItem(item) {
    count++;
    bytes += encoder.encode(JSON.stringify(item)).length + (count > 1 ? 1 : 0);
    if (count > LIMITS.items) throw new LibraryError("library-size");
    if (bytes > LIMITS.backup) throw new LibraryError("backup-size");
  }
  for (const item of current) {
    if (removed.has(item.id)) continue;
    countItem(replacements.get(item.id) ?? item);
    replacements.delete(item.id);
  }
  for (const item of replacements.values()) countItem(item);
}

function newId(used) {
  let id;
  do {
    const crypto = globalThis.crypto;
    id = crypto.randomUUID?.();
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  } while (used.has(id));
  return id;
}

export function mergeBackup(current, backup) {
  const index = indexTitles(current);
  const ids = new Set(current.map((item) => item.id));
  const put = [];
  let duplicates = 0;
  for (const candidate of backup.items) {
    if (index.find(candidate)) {
      duplicates++;
      continue;
    }
    const id = candidate.id && !ids.has(candidate.id) ? candidate.id : newId(ids);
    const item = { ...candidate, id };
    ids.add(id);
    index.add(item);
    put.push(item);
  }
  return {
    put,
    remove: [],
    result: { added: put.length, duplicates, skipped: backup.skipped, repaired: backup.repaired },
  };
}

export function addTitle(current, input, status, now = new Date()) {
  const data = normalizeTitleData(input);
  if (!data || !["watch", "watched"].includes(status)) throw new LibraryError("title");
  const existing = indexTitles(current).find(data);
  if (existing) return { put: [], remove: [], result: { id: existing.id, status: existing.status, added: false } };
  const item = {
    id: newId(new Set(current.map((entry) => entry.id))),
    ...data,
    status,
    myRating: 0,
    watchedAt: status === "watched" ? localDate(now) : "",
    note: "",
    addedAt: now.getTime(),
  };
  return { put: [item], remove: [], result: { id: item.id, status, added: true } };
}

export function editTitle(current, original, draft) {
  const latest = current.find((item) => item.id === original.id);
  if (!latest) throw new LibraryError("missing");
  const patch = {};
  for (const key of ["status", "myRating", "watchedAt", "note"]) {
    if (draft[key] === original[key]) continue;
    if (latest[key] !== original[key] && latest[key] !== draft[key]) throw new LibraryError("conflict");
    patch[key] = draft[key];
  }
  const updated = normalizeItem({ ...latest, ...patch });
  return { put: Object.keys(patch).length ? [updated] : [], remove: [], result: updated };
}

export function removeTitle(current, id) {
  if (!current.some((item) => item.id === id)) throw new LibraryError("missing");
  return { put: [], remove: [id], result: id };
}
