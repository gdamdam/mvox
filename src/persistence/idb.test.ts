import { describe, it, expect, afterEach, vi } from "vitest";
import {
  idbAvailable,
  idbSavePreset,
  idbDeletePreset,
  idbListPresets,
  type UserPreset,
} from "./idb";
import { DEFAULT_PATCH, type MvoxPatch } from "../audio/contracts";

// jsdom/node has no IndexedDB, and fake-indexeddb is not a dependency, so we
// hand-roll a minimal in-memory fake covering exactly the surface idb.ts uses
// (open/transaction/objectStore + getAll/put/delete/close). It also lets us
// drive the two hard-to-trigger edge cases: a `blocked` open that later
// succeeds (L14) and a synchronous throw from a store op (L15).

interface FakeOpts {
  // Fire onblocked (rejecting the open), then fire onsuccess a tick later to
  // simulate the blocking tab closing after we've already rejected.
  blockedThenSuccess?: boolean;
  // Make store.put throw synchronously (mimics DataCloneError).
  throwOnPut?: boolean;
}

interface FakeHarness {
  indexedDB: unknown;
  data: Map<unknown, { id: unknown; [k: string]: unknown }>;
  state: { closeCount: number };
}

function createFakeIDB(
  data = new Map<unknown, { id: unknown; [k: string]: unknown }>(),
  opts: FakeOpts = {},
): FakeHarness {
  const state = { closeCount: 0 };

  function makeStore() {
    return {
      getAll() {
        const req: Record<string, unknown> = { result: undefined, onsuccess: null };
        queueMicrotask(() => {
          req.result = Array.from(data.values());
          (req.onsuccess as (() => void) | null)?.();
        });
        return req;
      },
      put(rec: { id: unknown }) {
        if (opts.throwOnPut) throw new Error("DataCloneError");
        const req: Record<string, unknown> = { result: undefined, onsuccess: null };
        queueMicrotask(() => {
          data.set(rec.id, rec as { id: unknown });
          req.result = rec.id;
          (req.onsuccess as (() => void) | null)?.();
        });
        return req;
      },
      delete(key: unknown) {
        const req: Record<string, unknown> = { result: undefined, onsuccess: null };
        queueMicrotask(() => {
          data.delete(key);
          (req.onsuccess as (() => void) | null)?.();
        });
        return req;
      },
    };
  }

  function makeDB() {
    return {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => makeStore(),
      close() {
        state.closeCount++;
      },
      transaction() {
        const tx: Record<string, unknown> = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore: () => makeStore(),
        };
        // Complete the transaction after any request handlers have run.
        queueMicrotask(() => {
          queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
        });
        return tx;
      },
    };
  }

  const indexedDB = {
    open() {
      const req: Record<string, unknown> = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        if (opts.blockedThenSuccess) {
          (req.onblocked as (() => void) | null)?.();
          req.result = makeDB();
          queueMicrotask(() => (req.onsuccess as (() => void) | null)?.());
          return;
        }
        req.result = makeDB();
        (req.onupgradeneeded as (() => void) | null)?.();
        (req.onsuccess as (() => void) | null)?.();
      });
      return req;
    },
  };

  return { indexedDB, data, state };
}

// Let all queued microtasks (fake events) drain.
const flush = () => new Promise((r) => setTimeout(r, 0));

function makePatch(): MvoxPatch {
  return structuredClone(DEFAULT_PATCH) as MvoxPatch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("idbAvailable", () => {
  it("is false when no indexedDB global exists", () => {
    expect(idbAvailable()).toBe(false);
  });

  it("is true once indexedDB is present", () => {
    vi.stubGlobal("indexedDB", createFakeIDB().indexedDB);
    expect(idbAvailable()).toBe(true);
  });
});

describe("save / list / delete round-trip", () => {
  it("stores a preset and lists it back", async () => {
    const fake = createFakeIDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    const p: UserPreset = { id: "abc", name: "One", createdAt: 1, patch: makePatch() };
    await idbSavePreset(p);
    const list = await idbListPresets();
    expect(list.map((x) => x.id)).toEqual(["abc"]);
    expect(list[0].name).toBe("One");
  });

  it("deletes by the same string key that was listed", async () => {
    const fake = createFakeIDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    await idbSavePreset({ id: "abc", name: "One", createdAt: 1, patch: makePatch() });
    await idbDeletePreset("abc");
    expect(await idbListPresets()).toEqual([]);
    expect(fake.data.size).toBe(0);
  });

  it("closes the db after each transaction", async () => {
    const fake = createFakeIDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    await idbSavePreset({ id: "abc", name: "One", createdAt: 1, patch: makePatch() });
    expect(fake.state.closeCount).toBe(1);
  });
});

describe("L16: non-string keys", () => {
  it("skips numeric-keyed rows instead of surfacing an undeletable ghost", async () => {
    // A record stored with a numeric key: keyPath is "id", so its key IS 5.
    const data = new Map<unknown, { id: unknown; [k: string]: unknown }>([
      [5, { id: 5, name: "Ghost", createdAt: 1, patch: makePatch() }],
      ["real", { id: "real", name: "Real", createdAt: 2, patch: makePatch() }],
    ]);
    const fake = createFakeIDB(data);
    vi.stubGlobal("indexedDB", fake.indexedDB);

    const list = await idbListPresets();
    // Only the string-keyed row is listed; the numeric one is not coerced to "5".
    expect(list.map((x) => x.id)).toEqual(["real"]);

    // Deleting the listed id actually removes it (delete("5") would never have
    // matched the numeric key 5, the original bug).
    await idbDeletePreset("real");
    expect((await idbListPresets()).map((x) => x.id)).toEqual([]);
  });

  it("does not collapse several bad rows onto a duplicate empty id", async () => {
    const data = new Map<unknown, { id: unknown; [k: string]: unknown }>([
      [1, { id: 1, name: "A", createdAt: 1, patch: makePatch() }],
      [2, { id: 2, name: "B", createdAt: 2, patch: makePatch() }],
    ]);
    vi.stubGlobal("indexedDB", createFakeIDB(data).indexedDB);
    expect(await idbListPresets()).toEqual([]);
  });
});

describe("one throwing row must not hide all presets", () => {
  it("skips a future-version preset but still lists the valid ones", async () => {
    // migratePatch throws on a patch whose version is newer than we support (a
    // preset written by a later build). Listing must skip just that row, not
    // collapse the whole batch to [] and hide every valid preset.
    const data = new Map<unknown, { id: unknown; [k: string]: unknown }>([
      ["future", { id: "future", name: "Newer", createdAt: 1, patch: { version: 999 } }],
      ["ok", { id: "ok", name: "Valid", createdAt: 2, patch: makePatch() }],
    ]);
    const fake = createFakeIDB(data);
    vi.stubGlobal("indexedDB", fake.indexedDB);

    const list = await idbListPresets();
    expect(list.map((x) => x.id)).toEqual(["ok"]);
    // The future record is preserved on disk (a later build can still read it),
    // neither surfaced nor destroyed.
    expect(fake.data.has("future")).toBe(true);
  });
});

describe("L15: synchronous throw inside the transaction helper", () => {
  it("closes the db when a store op throws synchronously", async () => {
    const fake = createFakeIDB(new Map(), { throwOnPut: true });
    vi.stubGlobal("indexedDB", fake.indexedDB);
    // idbSavePreset swallows the rejection; the observable effect of the fix is
    // that the open connection was still closed rather than leaked.
    await idbSavePreset({ id: "abc", name: "One", createdAt: 1, patch: makePatch() });
    expect(fake.state.closeCount).toBe(1);
  });
});

describe("L14: onblocked then late onsuccess", () => {
  it("closes the connection that succeeds after the promise already rejected", async () => {
    const fake = createFakeIDB(new Map(), { blockedThenSuccess: true });
    vi.stubGlobal("indexedDB", fake.indexedDB);
    // The open rejects on onblocked, so the list call degrades to [].
    expect(await idbListPresets()).toEqual([]);
    // The blocking tab then closes and onsuccess fires on the settled promise;
    // that orphaned connection must be closed, not leaked.
    await flush();
    expect(fake.state.closeCount).toBe(1);
  });
});
