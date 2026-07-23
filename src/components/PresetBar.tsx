// Preset browsing + persistence + sharing. Factory presets load instantly; user
// presets live in IndexedDB; patches export/import as JSON and share via URL hash.

import { useEffect, useRef, useState } from 'react'
import type { MvoxPatch } from '../audio/contracts'
import { FACTORY_PRESETS, getFactoryPreset } from '../persistence/presets'
import { exportPatchJSON, importPatchJSON, migratePatch } from '../persistence/schema'
import {
  idbAvailable,
  idbDeletePreset,
  idbListPresets,
  idbSavePreset,
  type UserPreset,
} from '../persistence/idb'
import { patchToShareUrl } from '../sharing/codec'
import type { PerfSnapshot } from '../persistence/session'

interface Props {
  patch: MvoxPatch
  // Current performance state, captured into a preset when "with perf" is checked.
  perf: PerfSnapshot
  onLoad: (patch: MvoxPatch, perf?: PerfSnapshot) => void
}

function randomId(): string {
  // Non-crypto id is fine for local preset keys; timestamp + counter avoids RNG.
  return `u${Date.now().toString(36)}${(idCounter++).toString(36)}`
}
let idCounter = 0

export function PresetBar({ patch, perf, onLoad }: Props) {
  const [userPresets, setUserPresets] = useState<UserPreset[]>([])
  const [shareMsg, setShareMsg] = useState('')
  // When on, Save captures the current performance state (BPM, latch, MIDI maps,
  // channel) into the preset so recalling it restores the whole performance.
  const [includePerf, setIncludePerf] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // Latest-wins guard: concurrent list()s (e.g. save + delete) can resolve out of
  // order, and a resolve after unmount would set state on a dead component.
  const reqToken = useRef(0)
  const mounted = useRef(true)

  const refresh = () => {
    if (!idbAvailable()) return
    const token = ++reqToken.current
    void idbListPresets().then((list) => {
      if (mounted.current && token === reqToken.current) setUserPresets(list)
    })
  }
  useEffect(() => {
    refresh()
    return () => {
      mounted.current = false
    }
  }, [])

  const notify = (msg: string) => {
    setShareMsg(msg)
    setTimeout(() => setShareMsg(''), 3000)
  }

  const saveUser = async () => {
    const name = window.prompt('Preset name?', patch.name || 'My patch')
    if (!name) return
    // idbSavePreset never throws but reports failure explicitly — surface it so a
    // full/blocked IndexedDB can't silently imply the preset was saved.
    const res = await idbSavePreset({
      id: randomId(),
      name,
      createdAt: Date.now(),
      patch: { ...patch, name },
      perf: includePerf ? perf : undefined,
    })
    if (!res.ok) {
      notify(`Save failed: ${res.error}`)
      return
    }
    refresh()
  }

  const del = async (id: string) => {
    const res = await idbDeletePreset(id)
    if (!res.ok) {
      notify(`Delete failed: ${res.error}`)
      return
    }
    refresh()
  }

  const doExport = () => {
    const blob = new Blob([exportPatchJSON(patch)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(patch.name || 'mvox-patch').replace(/\s+/g, '-')}.json`
    a.click()
    // Revoking synchronously after click() can abort the download in some browsers
    // (Firefox); defer so the download has started.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const doImport = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const parsed = importPatchJSON(String(reader.result))
      if (parsed) onLoad(parsed)
      else setShareMsg('Import failed: invalid file')
    }
    reader.readAsText(file)
  }

  const share = async () => {
    const url = patchToShareUrl(patch, `${window.location.origin}${window.location.pathname}`)
    try {
      await navigator.clipboard.writeText(url)
      setShareMsg('Share link copied')
    } catch {
      // Clipboard may be blocked; drop the link into the hash so it's still shareable.
      window.location.hash = url.split('#')[1] ?? ''
      setShareMsg('Link in address bar')
    }
    setTimeout(() => setShareMsg(''), 2500)
  }

  return (
    <div className="presets">
      <div className="presets__row">
        <select
          className="presets__factory"
          value=""
          onChange={(e) => {
            const preset = getFactoryPreset(e.target.value)
            if (preset) onLoad({ ...preset.patch, name: preset.name })
          }}
        >
          <option value="">Factory presets…</option>
          {FACTORY_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.mode} · {p.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={saveUser} disabled={!idbAvailable()}>
          Save
        </button>
        <label className="presets__perf" title="Include BPM, latch, MIDI mappings and channel in the saved preset">
          <input type="checkbox" checked={includePerf} onChange={(e) => setIncludePerf(e.target.checked)} />
          with perf
        </label>
        <button type="button" onClick={doExport}>
          Export
        </button>
        <button type="button" onClick={() => fileRef.current?.click()}>
          Import
        </button>
        <button type="button" onClick={share}>
          Share
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) doImport(f)
            e.target.value = ''
          }}
        />
        {shareMsg ? <span className="presets__msg">{shareMsg}</span> : null}
      </div>
      {userPresets.length > 0 ? (
        <div className="presets__user">
          {userPresets.map((p) => (
            <span key={p.id} className="presets__chip">
              <button type="button" onClick={() => onLoad(migratePatch({ ...p.patch, name: p.name }), p.perf)}>
                {p.name}
                {p.perf ? <span className="presets__perf-badge" title="Includes performance state"> ●</span> : null}
              </button>
              <button type="button" className="presets__x" aria-label={`Delete ${p.name}`} onClick={() => del(p.id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
