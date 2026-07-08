// React binding for the framework-agnostic AudioEngine: owns the engine in a ref
// (never in state — it isn't serialisable), mirrors status + telemetry into state
// for the UI, and exposes stable action callbacks. Audio is created lazily on the
// first start() so it only happens after a user gesture.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioEngine, type EngineStatus } from '../audio/AudioEngine'
import type { MvoxPatch, Telemetry } from '../audio/contracts'
import { createMbusClient, type MbusClient, type Publication } from '../transport/mbus'

const IDLE_TELEMETRY: Telemetry = {
  type: 'telemetry',
  inputLevel: 0,
  outputPeak: 0,
  f0: 0,
  confidence: 0,
  activeVoices: 0,
}

export function useEngine() {
  const engineRef = useRef<AudioEngine | null>(null)
  const [status, setStatus] = useState<EngineStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [micOn, setMicOn] = useState(false)
  const [suspended, setSuspended] = useState(false)
  const [recording, setRecording] = useState(false)
  const telemetryRef = useRef<Telemetry>(IDLE_TELEMETRY)
  // mbus publish (see src/transport/mbus): offer the master output to the mbus
  // patchbay over the local link-bridge. Off by default and session-transient;
  // until enabled no client exists and no socket is opened, so behavior is
  // unchanged. With the bridge absent the client retries quietly.
  const mbusClientRef = useRef<MbusClient | null>(null)
  const mbusPubRef = useRef<Publication | null>(null)
  const mbusTapRef = useRef<AudioNode | null>(null)
  const [busPublishing, setBusPublishing] = useState(false)

  function ensureEngine(): AudioEngine {
    if (!engineRef.current) {
      const engine = new AudioEngine()
      engine.onStatus((s, err) => {
        setStatus(s)
        if (err) setError(err)
      })
      engine.onTelemetry((t) => {
        telemetryRef.current = t
      })
      // Mic can drop involuntarily (device unplugged) and the context can be
      // suspended by the browser; mirror both so the UI stays truthful.
      engine.onMic(setMicOn)
      engine.onSuspend(setSuspended)
      engineRef.current = engine
    }
    return engineRef.current
  }

  const start = useCallback(async () => {
    setError(null)
    try {
      await ensureEngine().start()
    } catch {
      // Status listener already surfaced the message.
    }
  }, [])

  const setPatch = useCallback((patch: MvoxPatch) => {
    engineRef.current?.setPatch(patch)
  }, [])

  const noteOn = useCallback((midi: number, velocity: number) => {
    engineRef.current?.noteOn({ midi, velocity })
  }, [])

  const noteOff = useCallback((midi: number) => {
    engineRef.current?.noteOff(midi)
  }, [])

  const panic = useCallback(() => {
    engineRef.current?.panic()
  }, [])

  const setTempo = useCallback((bpm: number) => {
    engineRef.current?.setTempo(bpm)
  }, [])

  const toggleBusPublish = useCallback(() => setBusPublishing((v) => !v), [])

  // Reconcile the bus intent with the live graph. Re-runs when the engine
  // (re)starts or closes so the publication always feeds the current tap;
  // disable unannounces the source and drops the bridge socket.
  useEffect(() => {
    const tap = engineRef.current?.getMasterTap() ?? null
    if (mbusPubRef.current && (mbusTapRef.current !== tap || !busPublishing)) {
      mbusPubRef.current.stop()
      mbusPubRef.current = null
      mbusTapRef.current = null
    }
    if (busPublishing && tap && !mbusPubRef.current) {
      mbusClientRef.current ??= createMbusClient()
      mbusClientRef.current.connect()
      mbusPubRef.current = mbusClientRef.current.publishOutput(tap, 'mvox')
      mbusTapRef.current = tap
    }
    if (!busPublishing) mbusClientRef.current?.disconnect()
  }, [busPublishing, status])

  const enableMic = useCallback(async () => {
    // Already on: a second tap must not re-invoke enable (avoids a redundant
    // getUserMedia / graph rebuild) and must keep the UI toggle consistent.
    if (micOn) return true
    const ok = (await engineRef.current?.enableMic()) ?? false
    setMicOn(ok)
    return ok
  }, [micOn])

  const disableMic = useCallback(() => {
    engineRef.current?.disableMic()
    setMicOn(false)
  }, [])

  const startRecording = useCallback(() => {
    engineRef.current?.startRecording()
    setRecording(true)
  }, [])

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    const blob = (await engineRef.current?.stopRecording()) ?? null
    setRecording(false)
    return blob
  }, [])

  // Read the latest telemetry snapshot each frame while running, into state, so
  // meters update without a re-render per worklet message.
  const [telemetry, setTelemetry] = useState<Telemetry>(IDLE_TELEMETRY)
  useEffect(() => {
    if (status !== 'running') return
    let raf = 0
    const tick = () => {
      setTelemetry(telemetryRef.current)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [status])

  useEffect(() => {
    return () => {
      void engineRef.current?.dispose()
      // Null the ref so a remount (StrictMode dev double-mount) lazily builds a
      // fresh engine instead of start()ing the disposed one.
      engineRef.current = null
    }
  }, [])

  return {
    status,
    error,
    micOn,
    suspended,
    recording,
    telemetry,
    start,
    setPatch,
    noteOn,
    noteOff,
    panic,
    setTempo,
    enableMic,
    disableMic,
    startRecording,
    stopRecording,
    busPublishing,
    toggleBusPublish,
  }
}
