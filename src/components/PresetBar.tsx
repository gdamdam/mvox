// Preset browsing + persistence + sharing. Factory presets load instantly; user
// presets live in IndexedDB; patches export/import as JSON and share via URL hash.

import { useEffect, useRef, useState } from 'react'
import type { MvoxPatch } from '../audio/contracts'
import { FACTORY_PRESETS, getFactoryPreset } from '../persistence/presets'
import { exportPatchJSON, importPatchJSON } from '../persistence/schema'
import {
  idbAvailable,
  idbDeletePreset,
  idbListPresets,
  idbSavePreset,
  type UserPreset,
} from '../persistence/idb'
import { patchToShareUrl } from '../sharing/codec'

interface Props {
  patch: MvoxPatch
  onLoad: (patch: MvoxPatch) => void
}

function randomId(): string {
  // Non-crypto id is fine for local preset keys; timestamp + counter avoids RNG.
  return `u${Date.now().toString(36)}${(idCounter++).toString(36)}`
}
let idCounter = 0

export function PresetBar({ patch, onLoad }: Props) {
  const [userPresets, setUserPresets] = useState<UserPreset[]>([])
  const [shareMsg, setShareMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = () => {
    if (idbAvailable()) void idbListPresets().then(setUserPresets)
  }
  useEffect(refresh, [])

  const saveUser = async () => {
    const name = window.prompt('Preset name?', patch.name || 'My patch')
    if (!name) return
    await idbSavePreset({ id: randomId(), name, createdAt: Date.now(), patch: { ...patch, name } })
    refresh()
  }

  const del = async (id: string) => {
    await idbDeletePreset(id)
    refresh()
  }

  const doExport = () => {
    const blob = new Blob([exportPatchJSON(patch)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(patch.name || 'mvox-patch').replace(/\s+/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
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
              <button type="button" onClick={() => onLoad({ ...p.patch, name: p.name })}>
                {p.name}
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
