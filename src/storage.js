import { checkLibraryCapacity, mergeBackup, parseBackup } from "./library.js";

const LEGACY_KEY = "cine:items";
const MIGRATION_KEY = "legacy-migration";
const ITEMS = "items";
const SETTINGS = "settings";

export function readLegacy() {
  let raw;
  try {
    raw = globalThis.localStorage.getItem(LEGACY_KEY);
  } catch {
    return { raw: null, backup: null, warning: "unreadable" };
  }
  if (raw === null) return { raw, backup: null, warning: null };
  try {
    return { raw, backup: parseBackup(raw), warning: null };
  } catch {
    return { raw, backup: null, warning: "invalid" };
  }
}

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(name, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ITEMS, { keyPath: "id" });
      request.result.createObjectStore(SETTINGS);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Database is blocked by another tab"));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close();
      else resolve(db);
    };
  });
}

function transact(db, stores, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let failure;
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("Transaction aborted"));

    function protect(callback) {
      try {
        callback();
      } catch (error) {
        failure = error;
        tx.abort();
      }
    }

    const read = (request, onResult) => {
      request.onsuccess = () => protect(() => onResult(request.result));
    };
    protect(() => run(tx, read, (value) => { result = value; }));
  });
}

function migrate(db) {
  return transact(db, [ITEMS, SETTINGS], "readwrite", (tx, read, finish) => {
    const settings = tx.objectStore(SETTINGS);
    read(settings.get(MIGRATION_KEY), (previous) => {
      if (previous !== undefined) {
        finish(previous);
        return;
      }

      const { backup, warning } = readLegacy();
      if (!backup) {
        if (warning !== "unreadable") settings.put(warning, MIGRATION_KEY);
        finish(warning);
        return;
      }

      const store = tx.objectStore(ITEMS);
      read(store.getAll(), (current) => {
        const changes = mergeBackup(current, backup);
        checkLibraryCapacity(current, changes);
        for (const item of changes.put) store.put(item);
        const issue = changes.result.skipped || changes.result.repaired || changes.result.duplicates ? "partial" : null;
        settings.put(issue, MIGRATION_KEY);
        finish(issue);
      });
    });
  });
}

export async function openLibrary() {
  const filePath = globalThis.location.protocol === "file:" ? `:${globalThis.location.pathname}` : "";
  const name = `didamesh-library${filePath}`;
  const db = await openDatabase(name);
  try {
    const migrationWarning = await migrate(db);
    let channel;
    try {
      channel = new BroadcastChannel(name);
    } catch {
      // Refreshing on window focus also covers browsers without BroadcastChannel.
    }

    return {
      read() {
        return transact(db, [ITEMS], "readonly", (tx, read, finish) => {
          read(tx.objectStore(ITEMS).getAll(), (items) => finish({ items, migrationWarning }));
        });
      },
      async mutate(reduce) {
        const { changed, result } = await transact(db, [ITEMS], "readwrite", (tx, read, finish) => {
          const store = tx.objectStore(ITEMS);
          read(store.getAll(), (current) => {
            const changes = reduce(current);
            if (changes.put.length) checkLibraryCapacity(current, changes);
            for (const item of changes.put) store.put(item);
            for (const id of changes.remove) store.delete(id);
            finish({ changed: changes.put.length > 0 || changes.remove.length > 0, result: changes.result });
          });
        });
        if (changed) {
          try {
            channel?.postMessage("updated");
          } catch {
            // Another tab can still refresh on focus after the transaction commits.
          }
        }
        return result;
      },
      subscribe(listener) {
        channel?.addEventListener("message", listener);
        globalThis.addEventListener("focus", listener);
      },
      close(listener) {
        globalThis.removeEventListener("focus", listener);
        channel?.close();
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
