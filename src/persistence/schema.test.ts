import { describe, it, expect } from "vitest";
import { exportPatchJSON, importPatchJSON, migratePatch } from "./schema";
import {
  DEFAULT_PATCH,
  sanitizePatch,
  RANGES,
  PATCH_VERSION,
} from "../audio/contracts";

describe("export/import round-trip", () => {
  it("round-trips a patch back to its sanitized form", () => {
    const original = DEFAULT_PATCH;
    const json = exportPatchJSON(original);
    const back = importPatchJSON(json);
    expect(back).toEqual(sanitizePatch(original));
  });

  it("emits pretty (indented) JSON", () => {
    expect(exportPatchJSON(DEFAULT_PATCH)).toContain("\n  ");
  });
});

describe("importPatchJSON never throws", () => {
  it("returns null on unparseable / non-object input", () => {
    expect(importPatchJSON("garbage")).toBeNull();
    expect(importPatchJSON("")).toBeNull();
    expect(importPatchJSON("123")).toBeNull();
    expect(importPatchJSON("[1,2,3]")).toBeNull();
    expect(importPatchJSON('"a string"')).toBeNull();
  });

  it("returns a valid patch for an object with junk fields", () => {
    const patch = importPatchJSON('{"mode":"harmony","garbage":true}');
    expect(patch).not.toBeNull();
    expect(patch?.mode).toBe("harmony");
    // Whatever came in, the result is fully valid.
    expect(sanitizePatch(patch!)).toEqual(patch);
  });
});

describe("migratePatch", () => {
  it("turns {} into a valid DEFAULT-like patch", () => {
    expect(migratePatch({})).toEqual(DEFAULT_PATCH);
  });

  it("clamps out-of-range values", () => {
    const migrated = migratePatch({
      shared: { masterGain: 999, keyRoot: -5 },
      fx: { reverb: 42 },
    });
    expect(migrated.shared.masterGain).toBe(RANGES.masterGain.max);
    expect(migrated.shared.keyRoot).toBe(RANGES.keyRoot.min);
    expect(migrated.fx.reverb).toBe(RANGES.fxReverb.max);
  });

  it("survives entirely non-object input", () => {
    expect(migratePatch(null)).toEqual(DEFAULT_PATCH);
    expect(migratePatch(42)).toEqual(DEFAULT_PATCH);
  });

  it("refuses future-version data instead of silently downgrading", () => {
    // A patch from a newer client (version 2). Downgrading would strip the
    // unknown `newerField` and restamp version to 1, permanently losing data on
    // re-save — so migratePatch must reject rather than sanitize it.
    const future = { version: PATCH_VERSION + 1, mode: "harmony", newerField: 7 };
    expect(() => migratePatch(future)).toThrow();
    // importPatchJSON tolerates bad input, so it surfaces the rejection as null
    // rather than a silently-downgraded v1 patch.
    expect(importPatchJSON(JSON.stringify(future))).toBeNull();
  });

  it("still migrates current-version data normally", () => {
    const current = migratePatch({ version: PATCH_VERSION, mode: "harmony" });
    expect(current.version).toBe(PATCH_VERSION);
    expect(current.mode).toBe("harmony");
  });
});
