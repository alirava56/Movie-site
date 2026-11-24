import assert from "node:assert/strict";
import test from "node:test";
import {
  addTitle, checkLibraryCapacity, editTitle, indexTitles, LIMITS, localDate, mergeBackup,
  normalizePoster, parseBackup, removeTitle, searchKey, serializeBackup,
} from "../src/library.js";

const now = new Date(2026, 10, 24, 0, 10);
const arrival = { title: "Arrival", year: 2016, kind: "movie", imdbId: "tt2543164" };

test("legacy arrays and V1 backups preserve metadata and V2 exports round-trip", () => {
  const legacy = {
    id: "legacy-arrival", ...arrival, status: "watched", myRating: 5, note: "یادداشت\nبا خط تازه",
    addedAt: 12345, watchedAt: "2024-02-29", poster: "https://example.com/poster.jpg",
  };
  for (const input of [[legacy], { v: 1, items: [legacy] }, { items: [legacy] }]) {
    const backup = parseBackup(`\uFEFF${JSON.stringify(input)}`);
    assert.equal(backup.repaired, 0);
    const { put, result } = mergeBackup([], backup);
    assert.equal(result.added, 1);
    assert.deepEqual(put[0], { ...legacy, year: "2016", genre: "", overview: "", imdbRating: null });
    assert.deepEqual(parseBackup(serializeBackup(put)).items, put);
  }
});

test("backup ingestion rejects unknown formats and normalizes malformed rows without admitting extra fields", () => {
  const backup = parseBackup(JSON.stringify({ v: 1, items: [
    { id: "duplicate", title: "عنوان اول", kind: "series", myRating: 18, status: "other", watchedAt: "2024-02-30", note: 27, poster: "http://example.com/poster.jpg", extra: "ignored" },
    { id: "duplicate", title: "عنوان دوم", year: "۱۴۰۳", status: "watch" },
    { title: 111 }, null, { title: "  " },
  ] }));
  assert.equal(backup.skipped, 3);
  assert.equal(backup.repaired, 1);
  const { put } = mergeBackup([], backup);
  assert.equal(new Set(put.map((item) => item.id)).size, 2);
  assert.equal(put[0].status, "watch");
  assert.equal(put[0].myRating, 0);
  assert.equal(put[0].watchedAt, "");
  assert.equal(put[0].note, "");
  assert.equal(put[0].poster, "");
  assert.equal(Object.hasOwn(put[0], "extra"), false);
  assert.equal(put[1].year, "1403");
  assert.throws(() => parseBackup('{"v":7,"items":[]}'), { code: "backup-version" });
  assert.throws(() => parseBackup('{"items":{}}'), { code: "backup-format" });
  assert.throws(() => parseBackup(" ".repeat(LIMITS.backup + 1)), { code: "backup-size" });
});

test("distinct IMDb IDs and kinds remain distinct, while alternate names for the same IMDb ID match", () => {
  const first = addTitle([], arrival, "watch", now).put[0];
  const same = addTitle([first], { ...arrival, title: "ورود" }, "watched", now);
  assert.equal(same.result.id, first.id);
  assert.equal(same.result.status, "watch");
  assert.deepEqual(same.put, []);
  const differentId = addTitle([first], { ...arrival, imdbId: "tt0000123" }, "watch", now).put[0];
  const series = addTitle([first, differentId], { ...arrival, imdbId: "", kind: "series" }, "watch", now).put[0];
  assert.ok(differentId && series);
  assert.equal(indexTitles([first, differentId]).find({ ...first, imdbId: "" }), undefined);
  const backup = parseBackup(serializeBackup([first, differentId, series]));
  assert.deepEqual(mergeBackup([first], backup).result, { added: 2, duplicates: 1, skipped: 0, repaired: 0 });
});

test("a watched entry starts with the user's local date and concurrent edits merge only untouched fields", () => {
  const first = addTitle([], arrival, "watched", now).put[0];
  assert.equal(localDate(now), "2026-11-24");
  assert.equal(first.watchedAt, localDate(now));
  const latest = { ...first, myRating: 4 };
  const edit = editTitle([latest], first, { ...first, note: "دیدنی" });
  assert.equal(edit.result.myRating, 4);
  assert.equal(edit.result.note, "دیدنی");
  assert.throws(() => editTitle([latest], first, { ...first, myRating: 3 }), { code: "conflict" });
  assert.throws(() => editTitle([], first, first), { code: "missing" });
  assert.deepEqual(removeTitle([first], first.id).remove, [first.id]);
});

test("Persian and Arabic characters and digits share searchable keys", () => {
  assert.equal(searchKey("  يِك‌تا ٢٠٢۶ "), searchKey("یکتا ۲۰۲۶"));
  assert.equal(searchKey("Árrival"), "arrival");
  const manual = addTitle([], { title: "Árrival" }, "watch", now).put;
  assert.equal(addTitle(manual, { title: "Arrival" }, "watch", now).result.added, true);
});

test("poster validation admits HTTPS and embedded raster formats within the size limit", () => {
  assert.equal(normalizePoster(" https://example.com/a.jpg "), "https://example.com/a.jpg");
  assert.equal(normalizePoster("https://user@example.com/a.jpg"), "");
  assert.equal(normalizePoster("data:image/jpeg;base64,YQ=="), "data:image/jpeg;base64,YQ==");
  assert.equal(normalizePoster("data:image/jpeg;base64,YQ==", { allowData: false }), "");
  assert.equal(normalizePoster("data:image/svg+xml,test"), "");
});

test("capacity checks the merged library before storage commits", () => {
  const item = addTitle([], arrival, "watch", now).put[0];
  const full = Array.from({ length: LIMITS.items }, (_, index) => ({ ...item, id: `item-${index}` }));
  assert.doesNotThrow(() => checkLibraryCapacity(full, { put: [{ ...full[0], note: "changed" }], remove: [] }));
  assert.throws(() => checkLibraryCapacity(full, { put: [item], remove: [] }), { code: "library-size" });
  const long = Array.from({ length: 850 }, (_, index) => ({ ...item, id: `long-${index}`, note: "یاد".repeat(5_000) }));
  assert.throws(() => checkLibraryCapacity(long, { put: [item], remove: [] }), { code: "backup-size" });
});
