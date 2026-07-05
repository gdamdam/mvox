// On-screen piano: shows two octaves from the current base octave, highlights
// the computer keys that map to each note, and plays on pointer press. Purely a
// convenience/visual aid — the computer keyboard is the primary input.

import { NOTE_CODES } from '../keyboard/layout'
import { NOTE_NAMES } from '../audio/dsp/scale'

// e.g. midi 60 → "C4", for screen-reader labels on the visual keys.
const noteName = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`

interface KeyboardProps {
  octave: number
  activeNotes: Set<number>
  onNoteOn: (midi: number, velocity: number) => void
  onNoteOff: (midi: number) => void
}

const WHITE = [0, 2, 4, 5, 7, 9, 11]
const BLACK: Record<number, boolean> = { 1: true, 3: true, 6: true, 8: true, 10: true }

// Reverse the code→semitone map to label keys on the visual keyboard.
const SEMITONE_TO_KEY = new Map<number, string>()
for (const [code, semi] of Object.entries(NOTE_CODES)) {
  if (!SEMITONE_TO_KEY.has(semi)) SEMITONE_TO_KEY.set(semi, code.replace('Key', ''))
}

export function Keyboard({ octave, activeNotes, onNoteOn, onNoteOff }: KeyboardProps) {
  const baseMidi = 12 * (octave + 1)
  const semitones = Array.from({ length: 24 }, (_, i) => i)

  return (
    <div className="keys" role="group" aria-label="On-screen keyboard">
      {semitones.map((semi) => {
        const midi = baseMidi + semi
        if (midi > 127) return null
        const isBlack = BLACK[semi % 12] ?? false
        if (isBlack) return null
        return (
          <div key={semi} className="keys__white-slot">
            <button
              type="button"
              className={`keys__white ${activeNotes.has(midi) ? 'keys__key--on' : ''}`}
              aria-label={noteName(midi)}
              onPointerDown={(e) => {
                // Ignore non-primary buttons (e.g. right-click): the context menu
                // swallows pointerup/leave, otherwise leaving the note stuck on.
                if (e.button === 0) onNoteOn(midi, 0.8)
              }}
              onPointerUp={() => onNoteOff(midi)}
              onPointerLeave={(e) => {
                if (e.buttons > 0) onNoteOff(midi)
              }}
              onPointerCancel={() => onNoteOff(midi)}
            >
              {semi < 12 && SEMITONE_TO_KEY.has(semi) ? (
                <span className="keys__hint">{SEMITONE_TO_KEY.get(semi)}</span>
              ) : null}
            </button>
            {BLACK[(semi + 1) % 12] && WHITE.includes(semi % 12) && midi + 1 <= 127 ? (
              <button
                type="button"
                className={`keys__black ${activeNotes.has(midi + 1) ? 'keys__key--on' : ''}`}
                aria-label={noteName(midi + 1)}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  // Ignore non-primary buttons (see white key above).
                  if (e.button === 0) onNoteOn(midi + 1, 0.8)
                }}
                onPointerUp={(e) => {
                  e.stopPropagation()
                  onNoteOff(midi + 1)
                }}
                onPointerLeave={(e) => {
                  if (e.buttons > 0) onNoteOff(midi + 1)
                }}
                onPointerCancel={(e) => {
                  e.stopPropagation()
                  onNoteOff(midi + 1)
                }}
              >
                {semi + 1 < 12 && SEMITONE_TO_KEY.has(semi + 1) ? (
                  <span className="keys__hint">{SEMITONE_TO_KEY.get(semi + 1)}</span>
                ) : null}
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
