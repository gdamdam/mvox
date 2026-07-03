// Factory presets are just MvoxPatches with a stable id + display name. They are
// pure data: no IndexedDB, no I/O — so they can be imported anywhere (UI, tests,
// worklet setup) without side effects. Every preset is built from DEFAULT_PATCH
// and funneled through sanitizePatch() at module load, guaranteeing that a typo
// in the override table can never ship an out-of-range value to the DSP core.

import {
  DEFAULT_PATCH,
  sanitizePatch,
  type MvoxPatch,
  type EngineMode,
} from "../audio/contracts";

export interface FactoryPreset {
  id: string;
  name: string;
  mode: EngineMode;
  patch: MvoxPatch;
}

// A deep-partial override applied on top of DEFAULT_PATCH. We keep this loose
// (Partial per section) because sanitizePatch fills any gaps and clamps anything
// out of range — the override table only needs to express the "interesting" deltas.
type PatchOverride = {
  vocoder?: Partial<MvoxPatch["vocoder"]>;
  harmony?: Partial<MvoxPatch["harmony"]>;
  formant?: Partial<MvoxPatch["formant"]>;
  follow?: Partial<MvoxPatch["follow"]>;
  shared?: Partial<MvoxPatch["shared"]>;
  fx?: Partial<MvoxPatch["fx"]>;
};

// Build a validated patch from DEFAULT_PATCH + a mode + tasteful overrides. Uses
// structuredClone so we never mutate the frozen DEFAULT_PATCH, then merges each
// section shallowly (sections are flat), sets name/mode, and sanitizes so the
// result is guaranteed valid and patch.mode === the preset's mode.
function build(name: string, mode: EngineMode, ov: PatchOverride): MvoxPatch {
  const base = structuredClone(DEFAULT_PATCH) as MvoxPatch;
  const merged: MvoxPatch = {
    ...base,
    name,
    mode,
    shared: { ...base.shared, ...ov.shared },
    vocoder: { ...base.vocoder, ...ov.vocoder },
    harmony: { ...base.harmony, ...ov.harmony },
    formant: { ...base.formant, ...ov.formant },
    follow: { ...base.follow, ...ov.follow },
    fx: { ...base.fx, ...ov.fx },
  };
  return sanitizePatch(merged);
}

// Exactly 10 presets spanning all four engine modes (>= 2 each):
//   vocoder x3, harmony x2, formant x3, follow x2.
export const FACTORY_PRESETS: readonly FactoryPreset[] = [
  {
    id: "voc-choir-machine",
    name: "Choir Machine",
    mode: "vocoder",
    patch: build("Choir Machine", "vocoder", {
      vocoder: { bands: 28, bassBoost: 0.5, sibilance: 0.3, release: 0.5 },
      fx: { reverb: 0.55, chorus: 0.4 },
    }),
  },
  {
    id: "voc-robo-talk",
    name: "Robo Talk",
    mode: "vocoder",
    patch: build("Robo Talk", "vocoder", {
      vocoder: {
        bands: 16,
        carrierWave: "pulse",
        sibilance: 0.6,
        release: 0.05,
      },
      fx: { drive: 0.3 },
    }),
  },
  {
    id: "voc-noise-choir",
    name: "Frost Vox",
    mode: "vocoder",
    patch: build("Frost Vox", "vocoder", {
      vocoder: {
        bands: 24,
        carrierWave: "noise",
        sibilance: 0.8,
        bassBoost: 0.1,
      },
      fx: { reverb: 0.6, delayMix: 0.25 },
    }),
  },
  {
    id: "har-fifth-stack",
    name: "Fifth Stack",
    mode: "harmony",
    patch: build("Fifth Stack", "harmony", {
      harmony: {
        voiceCount: 2,
        intervals: [4, 7, -3, 2],
        level: 0.8,
        spread: 0.6,
      },
    }),
  },
  {
    id: "har-wide-quartet",
    name: "Wide Quartet",
    mode: "harmony",
    patch: build("Wide Quartet", "harmony", {
      harmony: {
        voiceCount: 4,
        intervals: [2, 4, 7, -3],
        level: 0.65,
        spread: 1,
        detune: 14,
      },
      fx: { chorus: 0.5 },
    }),
  },
  {
    id: "fmt-little-robot",
    name: "Little Robot",
    mode: "formant",
    patch: build("Little Robot", "formant", {
      formant: { shift: 5, size: 0.7, robot: 0.8, ringHz: 220, ringAmount: 0.3 },
    }),
  },
  {
    id: "fmt-ghost-whisper",
    name: "Ghost Whisper",
    mode: "formant",
    patch: build("Ghost Whisper", "formant", {
      formant: { shift: -2, size: 1.2, whisper: 0.85 },
      fx: { reverb: 0.7 },
    }),
  },
  {
    id: "fmt-giant",
    name: "Giant",
    mode: "formant",
    patch: build("Giant", "formant", {
      formant: { shift: -7, size: 1.8 },
      fx: { drive: 0.2, reverb: 0.4 },
    }),
  },
  {
    id: "fol-lead-sync",
    name: "Lead Sync",
    mode: "follow",
    patch: build("Lead Sync", "follow", {
      follow: { glide: 0.1, blend: 1, confidenceGate: 0.6, wave: "saw" },
      fx: { drive: 0.25, delayMix: 0.3, delayFeedback: 0.4 },
    }),
  },
  {
    id: "fol-glide-pad",
    name: "Glide Pad",
    mode: "follow",
    patch: build("Glide Pad", "follow", {
      follow: { glide: 0.7, blend: 0.8, confidenceGate: 0.4, wave: "pulse" },
      fx: { reverb: 0.6, chorus: 0.4 },
    }),
  },
];

// Linear scan is fine: the table is tiny (10 entries) and this runs on user
// intent (loading a preset), not in the audio hot path.
export function getFactoryPreset(id: string): FactoryPreset | undefined {
  return FACTORY_PRESETS.find((p) => p.id === id);
}
