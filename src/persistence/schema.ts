// Pure (I/O-free) helpers for moving patches across trust boundaries: JSON
// export/import for files and clipboard, plus a forward-migration entry point.
// Everything funnels through sanitizePatch() so no untrusted or stale-shaped
// data can reach the DSP core.

import {
  sanitizePatch,
  PATCH_VERSION,
  type MvoxPatch,
} from "../audio/contracts";

// A user preset as persisted (IndexedDB) or serialized. It wraps a patch with
// identity/metadata that the patch itself doesn't carry.
export interface StoredPreset {
  id: string;
  name: string;
  createdAt: number;
  patch: MvoxPatch;
}

// Serialize a patch for a file / clipboard. We sanitize on the way out too, so an
// exported file is always well-formed regardless of what the caller handed us.
// Pretty-printed because these files are meant to be human-readable and diffable.
export function exportPatchJSON(patch: MvoxPatch): string {
  return JSON.stringify(sanitizePatch(patch), null, 2);
}

// Parse untrusted text into a patch. Never throws: returns null on unparseable
// input or when the parsed value isn't an object-shaped patch, otherwise a fully
// migrated + sanitized patch. Note that a bare JSON number/string/array parses
// fine but isn't a patch record, so we reject it rather than silently returning
// an all-defaults patch — the caller can distinguish "bad input" from "empty patch".
export function importPatchJSON(text: string): MvoxPatch | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return migratePatch(parsed);
}

// Forward-migrate a raw stored value to the current patch shape, then sanitize.
// Today there is only one version, so this is effectively sanitizePatch(). It is
// structured as a version switch so future breaking changes can add ordered
// migration steps (v1->v2, v2->v3, ...) before the final sanitize pass.
export function migratePatch(raw: unknown): MvoxPatch {
  const version =
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { version?: unknown }).version === "number"
      ? (raw as { version: number }).version
      : 0;

  const working = raw;

  // Migration ladder: each step upgrades one version to the next. Left empty for
  // now (v1 is current); add `if (version < N) working = stepToN(working)` here.
  void version;
  void PATCH_VERSION;

  // Final pass fills defaults, clamps ranges, and stamps the current version.
  return sanitizePatch(working);
}
