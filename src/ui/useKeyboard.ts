// Binds the Ableton-style computer-keyboard note layout to note callbacks.
// Tracks held physical keys (to suppress OS auto-repeat), the current octave and
// velocity, and never fires while the user is typing in a form field.

import { useEffect, useRef, useState } from 'react'
import {
  MAX_OCTAVE,
  MIN_OCTAVE,
  OCTAVE_DOWN_CODE,
  OCTAVE_UP_CODE,
  VELOCITY_DOWN_CODE,
  VELOCITY_UP_CODE,
  clampOctave,
  isEditableTarget,
  midiForCode,
} from '../keyboard/layout'

export interface KeyboardHandlers {
  onNoteOn: (midi: number, velocity: number) => void
  onNoteOff: (midi: number) => void
  enabled: boolean
}

const VELOCITY_STEP = 0.15

export function useKeyboard({ onNoteOn, onNoteOff, enabled }: KeyboardHandlers) {
  const [octave, setOctave] = useState(4)
  const [velocity, setVelocity] = useState(0.8)
  // Refs so the event handlers (bound once) always see current values.
  const octaveRef = useRef(octave)
  const velocityRef = useRef(velocity)
  const enabledRef = useRef(enabled)
  const heldRef = useRef(new Map<string, number>()) // code -> midi currently sounding
  const onNoteOnRef = useRef(onNoteOn)
  const onNoteOffRef = useRef(onNoteOff)

  // Keep the "latest value" refs in sync after each commit so the once-bound
  // window listeners always read current props without re-subscribing.
  useEffect(() => {
    octaveRef.current = octave
    velocityRef.current = velocity
    enabledRef.current = enabled
    onNoteOnRef.current = onNoteOn
    onNoteOffRef.current = onNoteOff
  })

  useEffect(() => {
    function releaseAll() {
      for (const midi of heldRef.current.values()) onNoteOffRef.current(midi)
      heldRef.current.clear()
    }

    function down(e: KeyboardEvent) {
      if (!enabledRef.current || e.repeat || isEditableTarget(e.target)) return
      const code = e.code
      if (code === OCTAVE_DOWN_CODE) {
        setOctave((o) => clampOctave(o - 1))
        return
      }
      if (code === OCTAVE_UP_CODE) {
        setOctave((o) => clampOctave(o + 1))
        return
      }
      if (code === VELOCITY_DOWN_CODE) {
        setVelocity((v) => Math.max(0.05, +(v - VELOCITY_STEP).toFixed(2)))
        return
      }
      if (code === VELOCITY_UP_CODE) {
        setVelocity((v) => Math.min(1, +(v + VELOCITY_STEP).toFixed(2)))
        return
      }
      const midi = midiForCode(code, octaveRef.current)
      if (midi === null || heldRef.current.has(code)) return
      heldRef.current.set(code, midi)
      onNoteOnRef.current(midi, velocityRef.current)
    }

    function up(e: KeyboardEvent) {
      const code = e.code
      const midi = heldRef.current.get(code)
      if (midi === undefined) return
      heldRef.current.delete(code)
      onNoteOffRef.current(midi)
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    // Releasing on blur/visibility change prevents stuck notes when focus leaves.
    window.addEventListener('blur', releaseAll)
    return () => {
      releaseAll()
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', releaseAll)
    }
  }, [])

  return {
    octave,
    velocity,
    setOctave: (o: number) => setOctave(clampOctave(o)),
    setVelocity: (v: number) => setVelocity(Math.max(0.05, Math.min(1, v))),
    minOctave: MIN_OCTAVE,
    maxOctave: MAX_OCTAVE,
  }
}
