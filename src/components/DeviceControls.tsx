// Device / latency / CPU panel. Shows the active sample rate + latency, lets the
// user pick input (and output, where the browser supports it), toggle a quality
// mode, and — only where a defensible metric exists — a render-load meter. All
// values come from the engine; nothing here invents precision.

import type { DeviceList, EngineInfo, QualityMode } from '../audio/AudioEngine'
import { Meter, Select } from './controls'

interface Props {
  info: EngineInfo | null
  renderLoad: number | null
  quality: QualityMode
  onQuality: (q: QualityMode) => void
  devices: DeviceList
  inputId: string | null
  outputId: string | null
  onInput: (id: string | null) => void
  onOutput: (id: string) => void
  onRefresh: () => void
  running: boolean
}

const ms = (s: number | null | undefined) => (typeof s === 'number' ? `${(s * 1000).toFixed(1)} ms` : '—')

export function DeviceControls({ info, renderLoad, quality, onQuality, devices, inputId, outputId, onInput, onOutput, onRefresh, running }: Props) {
  const inputOptions = [{ value: '', label: 'Default input' }, ...devices.inputs.map((d) => ({ value: d.id, label: d.label }))]
  const outputOptions = [{ value: '', label: 'Default output' }, ...devices.outputs.map((d) => ({ value: d.id, label: d.label }))]

  return (
    <div className="devices">
      <div className="devices__row">
        <Select label="Input" value={inputId ?? ''} options={inputOptions} onChange={(v: string) => onInput(v || null)} />
        {info?.outputSelectionSupported ? (
          <Select label="Output" value={outputId ?? ''} options={outputOptions} onChange={(v: string) => onOutput(v)} />
        ) : (
          <span className="devices__note" title="This browser can't route Web Audio to a chosen output device">Output: system default</span>
        )}
        <button type="button" className="btn devices__refresh" onClick={onRefresh} title="Re-scan devices (labels appear after mic permission)">
          ↻
        </button>
      </div>

      <div className="devices__row">
        <span className="devices__label">Quality</span>
        <button type="button" className={quality === 'normal' ? 'btn btn--on' : 'btn'} aria-pressed={quality === 'normal'} onClick={() => onQuality('normal')}>
          Normal
        </button>
        <button type="button" className={quality === 'safe' ? 'btn btn--on' : 'btn'} aria-pressed={quality === 'safe'} onClick={() => onQuality('safe')} title="Larger buffer: fewer dropouts, more latency">
          Safe
        </button>
        {running ? <span className="devices__note">applies on next start</span> : null}
      </div>

      <div className="devices__row devices__stats">
        <span>Rate: {info ? `${(info.sampleRate / 1000).toFixed(1)} kHz` : '—'}</span>
        <span>Base lat: {ms(info?.baseLatency)}</span>
        <span>Out lat: {ms(info?.outputLatency)}</span>
      </div>

      {info?.loadMetricSupported && renderLoad !== null ? (
        <div className="devices__row">
          <Meter label="CPU" value={renderLoad} tone={renderLoad > 0.85 ? 'signal' : 'accent'} />
          <span className="devices__note">render load</span>
        </div>
      ) : (
        <span className="devices__note">CPU load metric unavailable in this browser.</span>
      )}
    </div>
  )
}
