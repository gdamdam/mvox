import { describe, it, expect } from "vitest";
import { FACTORY_PRESETS, getFactoryPreset } from "./presets";
import { sanitizePatch, ENGINE_MODES } from "../audio/contracts";

describe("factory presets", () => {
  it("ships exactly 10 presets", () => {
    expect(FACTORY_PRESETS).toHaveLength(10);
  });

  it("has unique ids", () => {
    const ids = FACTORY_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("represents every engine mode at least twice", () => {
    for (const mode of ENGINE_MODES) {
      const count = FACTORY_PRESETS.filter((p) => p.mode === mode).length;
      expect(count, `mode ${mode}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps patch.mode in sync with the preset mode", () => {
    for (const p of FACTORY_PRESETS) {
      expect(p.patch.mode, p.id).toBe(p.mode);
    }
  });

  it("holds only valid, sanitize-idempotent patches", () => {
    for (const p of FACTORY_PRESETS) {
      // If the patch is already valid + in-range, sanitizing it is a no-op.
      expect(sanitizePatch(p.patch), p.id).toEqual(p.patch);
    }
  });
});

describe("getFactoryPreset", () => {
  it("finds a known preset", () => {
    const found = getFactoryPreset("voc-choir-machine");
    expect(found?.name).toBe("Choir Machine");
    expect(found?.mode).toBe("vocoder");
  });

  it("returns undefined for junk ids", () => {
    expect(getFactoryPreset("nope")).toBeUndefined();
    expect(getFactoryPreset("")).toBeUndefined();
  });
});
