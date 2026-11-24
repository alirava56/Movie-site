import assert from "node:assert/strict";
import test from "node:test";
import { catalogOptions, catalogParams, providerCatalog } from "../src/catalog.js";

const options = (query) => catalogOptions(new URLSearchParams(query));

test("only supported methods of querying the catalog are representable as options", () => {
  assert.deepEqual(options("kind=series&genre=Sci-Fi&offset=50"), { kind: "series", catalog: "top", genre: "Sci-Fi", q: "", offset: 50 });
  for (const value of ["kind=other", "genre=unknown", "offset=17", "offset=999", "q=a&genre=Drama", "q=a&offset=50", "kind=series&kind=movie", "unknown=x"]) {
    assert.equal(options(value), null, value);
  }
  const value = options("q=%20Arrival%20%20%26%20more%20");
  assert.equal(value.q, "Arrival & more");
  assert.deepEqual(catalogOptions(catalogParams(value)), value);
});

test("Cinemeta browsing advances fixed windows despite short, duplicate, or invalid rows", async () => {
  const visited = [];
  const fetcher = async (url, settings) => {
    visited.push(url);
    assert.equal(settings.redirect, "error");
    return Response.json({ metas: [
      null,
      { name: "First", id: "tt0000123", year: {}, releaseInfo: "2020–", imdbRating: "7.3" },
      { id: "tt0000123", name: "First" },
      { name: 22 },
    ] });
  };
  const page = await providerCatalog(options("kind=series&genre=Sci-Fi&offset=50"), { fetcher });
  assert.equal(visited[0], "https://cinemeta-catalogs.strem.io/top/catalog/series/top/genre=Sci-Fi&skip=50.json");
  assert.equal(page.nextOffset, 100);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].kind, "series");
  assert.equal(page.items[0].year, "2020");
  assert.equal(page.items[0].imdbRating, 7.3);
  const last = await providerCatalog(options("offset=950"), { fetcher });
  assert.equal(last.nextOffset, null);
});

test("search encodes the query, falls back to IMDb only when necessary, and scopes suggestions by kind", async () => {
  const visited = [];
  const fetcher = async (url) => {
    visited.push(url);
    if (visited.length === 1) return Response.json({ metas: [] });
    return Response.json({ d: [
      { id: "tt0000001", qid: "movie", l: "Movie", y: 2011 },
      { id: "tt0000002", qid: "tvSeries", l: "Series", y: 2012 },
    ] });
  };
  const page = await providerCatalog(options("kind=series&q=A+%26+B"), { fetcher });
  assert.equal(visited[0], "https://v3-cinemeta.strem.io/catalog/series/top/search=A%20%26%20B.json");
  assert.equal(visited[1], "https://v3.sg.media-imdb.com/suggestion/a/a%20%26%20b.json");
  assert.equal(page.source, "imdb");
  assert.equal(page.items[0].title, "Series");
  assert.equal(page.nextOffset, null);
});

test("a failed fallback does not erase a valid empty response, while unavailable upstream is reported as a failure", async () => {
  const fetcher = async (url) => url.includes("cinemeta") ? Response.json({ metas: [] }) : new Response(null, { status: 503 });
  const page = await providerCatalog(options("q=nothing"), { fetcher });
  assert.deepEqual(page, { items: [], nextOffset: null, source: "cinemeta" });
  await assert.rejects(providerCatalog(options(""), { fetcher: async () => Response.json({ metas: {} }) }), /Invalid Cinemeta/);
  await assert.rejects(providerCatalog(options(""), { fetcher: async () => new Response("x".repeat(4 * 1024 * 1024 + 1)) }), /too large/);
});
