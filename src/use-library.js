import { useCallback, useEffect, useRef, useState } from "react";
import { LibraryError, mergeBackup } from "./library.js";
import { openLibrary, readLegacy } from "./storage.js";

const EMPTY = { status: "loading", items: [], migrationWarning: null };

export function useLibrary() {
  const [library, setLibrary] = useState(EMPTY);
  const [attempt, setAttempt] = useState(0);
  const activeStore = useRef(null);

  useEffect(() => {
    let alive = true;
    let store;
    let latestRead = 0;

    async function refresh() {
      const readId = ++latestRead;
      try {
        const snapshot = await store.read();
        if (alive && readId === latestRead) setLibrary({ status: "ready", ...snapshot });
      } catch {
        if (alive && readId === latestRead) setLibrary((last) => ({ ...last, status: "error" }));
      }
    }

    openLibrary().then((opened) => {
      store = opened;
      if (!alive) {
        store.close(refresh);
        return;
      }
      activeStore.current = { store, refresh };
      store.subscribe(refresh);
      void refresh();
    }).catch(() => {
      if (!alive) return;
      const { backup, warning } = readLegacy();
      const fallback = backup ? mergeBackup([], backup).put : [];
      setLibrary((last) => ({
        status: "error",
        items: last.items.length ? last.items : fallback,
        migrationWarning: last.migrationWarning ?? warning,
      }));
    });

    return () => {
      alive = false;
      activeStore.current = null;
      store?.close(refresh);
    };
  }, [attempt]);

  const mutate = useCallback(async (reduce) => {
    const active = activeStore.current;
    if (!active) throw new LibraryError("storage");
    try {
      const result = await active.store.mutate(reduce);
      if (activeStore.current === active) await active.refresh();
      return result;
    } catch (error) {
      if (activeStore.current === active && ["conflict", "missing"].includes(error?.code)) await active.refresh();
      throw error;
    }
  }, []);

  return {
    ...library,
    mutate,
    retry() {
      setLibrary((last) => ({ ...last, status: "loading" }));
      setAttempt((last) => last + 1);
    },
  };
}
