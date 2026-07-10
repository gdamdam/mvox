// Minimal async IndexedDB wrapper for USER presets. Deliberately tiny and fully
// guarded: private-browsing modes, disabled storage, and quota errors are common,
// so every operation degrades to a safe no-op / empty result instead of throwing.
// On READ we re-run each stored patch through migratePatch (the trust boundary),
// so corrupt or stale-shaped data on disk can never reach the app.

import type { MvoxPatch } from "../audio/contracts";
import { migratePatch } from "./schema";

export interface UserPreset {
  id: string;
  name: string;
  createdAt: number;
  patch: MvoxPatch;
}

const DB_NAME = "mvox";
const STORE = "presets";
const DB_VERSION = 1;

// Feature-detect indexedDB. `typeof` guards against non-browser contexts (SSR,
// the worklet, Node test runs) where the global simply doesn't exist.
export function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

// Open (and lazily create) the object store. Rejects on any error so callers can
// catch-and-degrade; the store uses `id` as its keyPath so put() upserts by id.
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!idbAvailable()) {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Track settlement: onblocked/onerror reject, but the underlying open can
    // still succeed later (e.g. once the blocking tab closes). If we resolved
    // that late success we'd hand out a rejected promise's DB; if we ignored it
    // we'd leak an open connection that blocks all future version upgrades.
    let settled = false;
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      if (settled) {
        // Promise already rejected — close the now-orphaned connection.
        req.result.close();
        return;
      }
      resolve(req.result);
    };
    req.onerror = () => {
      settled = true;
      reject(req.error ?? new Error("indexedDB open failed"));
    };
    req.onblocked = () => {
      settled = true;
      reject(new Error("indexedDB blocked"));
    };
  });
}

// Run one transaction and resolve when it completes (not merely when the request
// succeeds) so writes are durable before we report success.
function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result: T | undefined;
        let req: IDBRequest<T> | null;
        try {
          req = fn(store);
        } catch (err) {
          // A synchronous throw from fn (e.g. DataCloneError from store.put on a
          // non-cloneable value) would otherwise skip every db.close() below and
          // leak the open connection.
          db.close();
          reject(err);
          return;
        }
        if (req) req.onsuccess = () => (result = req.result);
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("indexedDB txn failed"));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("indexedDB txn aborted"));
        };
      }),
  );
}

// Upsert a preset. Swallows errors: persistence is best-effort, and a failed save
// should not crash a live performance.
export async function idbSavePreset(p: UserPreset): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.put(p));
  } catch {
    // no-op: storage unavailable or write rejected
  }
}

export async function idbDeletePreset(id: string): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.delete(id));
  } catch {
    // no-op
  }
}

// List all presets, sanitizing every patch on the way out. Returns [] on any
// failure so the UI can always render. migratePatch guarantees each `patch` is a
// valid current-version MvoxPatch even if the stored record was partial/corrupt.
export async function idbListPresets(): Promise<UserPreset[]> {
  try {
    const rows = await withStore<UserPreset[]>("readonly", (store) =>
      store.getAll(),
    );
    if (!Array.isArray(rows)) return [];
    // The store's keyPath is "id", so a row's key IS its `id`. Coercing a numeric
    // (or otherwise non-string) key to a string would list a preset under an id
    // that idbDeletePreset(id: string) can never match — an undeletable ghost
    // that reappears on every load. Skip such rows: the app only ever writes
    // string ids (randomId), so these are foreign/corrupt records we shouldn't
    // surface. This also avoids collapsing several bad rows onto a duplicate ""
    // id. Migrating the DB to repair keys would require a version bump.
    const out: UserPreset[] = [];
    for (const row of rows) {
      if (typeof row?.id !== "string") continue;
      try {
        out.push({
          id: row.id,
          name: typeof row?.name === "string" ? row.name : "Preset",
          createdAt: typeof row?.createdAt === "number" ? row.createdAt : 0,
          // migratePatch throws on a future-version record; catching PER ROW keeps
          // one preset saved by a newer build from hiding every valid preset. The
          // bad row is left on disk (a later newer build can still read it) — we
          // neither surface nor destroy it.
          patch: migratePatch(row?.patch),
        });
      } catch {
        // Skip this row only; a partial/corrupt/future record must not blank the
        // whole list.
      }
    }
    return out;
  } catch {
    return [];
  }
}
