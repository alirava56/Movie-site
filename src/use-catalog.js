import { useEffect, useRef, useState } from "react";
import { catalogItemKey, fetchCatalog } from "./catalog.js";

const EMPTY = { items: [], status: "loading", nextOffset: null, partial: false };

async function searchBoth(options, signal) {
  const pages = await Promise.allSettled(["movie", "series"].map((kind) => fetchCatalog({ ...options, kind }, signal)));
  const found = pages.filter((page) => page.status === "fulfilled");
  if (!found.length) throw new Error("Search unavailable");
  return { items: found.flatMap((entry) => entry.value.items.slice(0, 8)), nextOffset: null, partial: found.length === 1 };
}

export function useCatalog({ kind, catalog = "top", genre = "", q = "" }, { enabled = true, both = false } = {}) {
  const key = JSON.stringify([kind, catalog, genre, q, enabled, both]);
  const [page, setPage] = useState({ ...EMPTY, key });
  const [attempt, setAttempt] = useState(0);
  const active = useRef(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const options = { kind, catalog, genre, q };
    const request = { controller, options, key, pending: true };
    active.current = request;
    setPage({ ...EMPTY, key });
    const fetchPage = both ? searchBoth : fetchCatalog;
    fetchPage(options, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPage({ ...EMPTY, ...result, status: "ready", key });
    }).catch(() => {
      if (!controller.signal.aborted) setPage({ ...EMPTY, status: "error", key });
    }).finally(() => { request.pending = false; });
    return () => controller.abort();
  }, [kind, catalog, genre, q, enabled, both, key, attempt]);

  async function loadMore() {
    const request = active.current;
    if (!request || request.key !== key || request.pending || page.key !== key || page.nextOffset === null) return;
    const signal = request.controller.signal;
    request.pending = true;
    setPage((last) => ({ ...last, status: "paging" }));
    try {
      const result = await fetchCatalog({ ...request.options, offset: page.nextOffset }, signal);
      if (signal.aborted) return;
      setPage((last) => {
        const seen = new Set(last.items.map(catalogItemKey));
        const added = result.items.filter((item) => !seen.has(catalogItemKey(item)));
        const repeated = result.items.length > 0 && added.length === 0;
        return { ...last, items: [...last.items, ...added], nextOffset: repeated ? null : result.nextOffset, status: "ready" };
      });
    } catch {
      if (!signal.aborted) setPage((last) => ({ ...last, status: "page-error" }));
    } finally {
      request.pending = false;
    }
  }

  const visiblePage = enabled ? (page.key === key ? page : EMPTY) : { ...EMPTY, status: "idle" };
  return { ...visiblePage, loadMore, retry: () => setAttempt((last) => last + 1) };
}
