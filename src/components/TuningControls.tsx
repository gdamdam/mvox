// Compact microtuning selector for the HARMONY/FOLLOW settings area. Picks a
// vendored preset, imports a Scala `.scl` file, or pastes an mdrone share link
// ("harmonise your voice in your mdrone tuning"). Tuning affects only the
// scale-pitched internal engines (HARMONY snap + voices, FOLLOW synth). Rejected
// imports surface an inline notice — never a silent no-op.

import { useState } from 'react'
import type { MvoxPatch } from '../audio/contracts'
import { importSclText, TUNING_PRESETS } from '../audio/tuning'
import { importTuningFromUrl } from '../audio/linkImport'
import { NOTE_NAMES } from '../audio/dsp/scale'
import { Select } from './controls'

interface Props {
  patch: MvoxPatch
  update: (mut: (p: MvoxPatch) => void) => void
}

export function TuningControls({ patch, update }: Props) {
  const [notice, setNotice] = useState<string | null>(null)
  const [link, setLink] = useState('')

  const tuning = patch.shared.tuning
  // Value shown in the dropdown: a preset name, or the imported tuning's own name
  // added as a synthetic option so an imported scale still displays.
  const known = TUNING_PRESETS.some((t) => t.name === tuning.name)
  const options = [
    ...TUNING_PRESETS.map((t) => ({ value: t.name, label: t.name })),
    ...(known ? [] : [{ value: tuning.name, label: `${tuning.name} (imported)` }]),
  ]

  const selectPreset = (name: string) => {
    const preset = TUNING_PRESETS.find((t) => t.name === name)
    if (!preset) return
    update((p) => {
      p.shared.tuning = { name: preset.name, scaleCents: [...preset.scaleCents], period: preset.period }
    })
    setNotice(null)
  }

  const onSclFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked after a fix
    if (!file) return
    file
      .text()
      .then((text) => {
        try {
          const spec = importSclText(text)
          update((p) => {
            p.shared.tuning = spec
          })
          setNotice(`Loaded ${spec.name}`)
        } catch {
          setNotice('Invalid .scl file — check the scale and try again')
        }
      })
      .catch(() => setNotice('Could not read that file'))
  }

  const onImportLink = async () => {
    const imported = await importTuningFromUrl(link.trim())
    if (!imported) {
      setNotice('Could not read a tuning from that link')
      return
    }
    update((p) => {
      p.shared.keyRoot = imported.root
      p.shared.tuning = imported.tuning
    })
    setNotice(`Imported ${imported.tuning.name} · ${NOTE_NAMES[imported.root]}`)
    setLink('')
  }

  const activeTonic = NOTE_NAMES[patch.shared.keyRoot] ?? '?'

  return (
    <div className="tuning">
      <Select label="Tuning" value={tuning.name} options={options} onChange={selectPreset} />
      <span className="tuning__active" title="Active tuning and tonic">
        {tuning.scaleCents.length > 0 ? `${tuning.name} · ${activeTonic}` : '12-TET · scale mode'}
      </span>
      <label className="tuning__scl">
        <span>.scl</span>
        <input type="file" accept=".scl,.txt,text/plain" onChange={onSclFile} />
      </label>
      <div className="tuning__link">
        <input
          type="text"
          placeholder="Paste mdrone link"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <button type="button" onClick={onImportLink} disabled={link.trim().length === 0}>
          Import
        </button>
      </div>
      {notice ? <span className="tuning__notice">{notice}</span> : null}
    </div>
  )
}
