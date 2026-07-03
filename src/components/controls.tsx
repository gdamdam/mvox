// Small presentational controls shared across the mode panels. Kept dependency-
// free (plain range inputs + pointer math) so they stay predictable and cheap.

import { useCallback, useRef } from 'react'

interface KnobProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}

export function Knob({ label, value, min, max, step, unit, onChange }: KnobProps) {
  const display = Number.isInteger(value) ? value.toString() : value.toFixed(2)
  return (
    <label className="knob">
      <span className="knob__label">{label}</span>
      <input
        className="knob__input"
        type="range"
        min={min}
        max={max}
        step={step ?? (max - min) / 100}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="knob__value">
        {display}
        {unit ? <span className="knob__unit">{unit}</span> : null}
      </span>
    </label>
  )
}

interface ToggleProps {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}

export function Toggle({ label, value, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      className={`toggle ${value ? 'toggle--on' : ''}`}
      aria-pressed={value}
      onClick={() => onChange(!value)}
    >
      {label}
    </button>
  )
}

interface SelectProps<T extends string> {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}

export function Select<T extends string>({ label, value, options, onChange }: SelectProps<T>) {
  return (
    <label className="select">
      <span className="select__label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

interface MeterProps {
  label: string
  value: number // 0..1
  tone?: 'signal' | 'accent' | 'danger'
}

export function Meter({ label, value, tone = 'signal' }: MeterProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className="meter" title={label}>
      <span className="meter__label">{label}</span>
      <div className="meter__track">
        <div className={`meter__fill meter__fill--${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

interface XYPadProps {
  x: number
  y: number
  xLabel: string
  yLabel: string
  onChange: (x: number, y: number) => void
}

export function XYPad({ x, y, xLabel, yLabel, onChange }: XYPadProps) {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const emit = useCallback(
    (clientX: number, clientY: number) => {
      const el = ref.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      // Invert Y so up = 1 (natural for "more").
      const ny = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height))
      onChange(nx, ny)
    },
    [onChange],
  )

  return (
    <div
      ref={ref}
      className="xypad"
      role="slider"
      aria-label={`XY pad: ${xLabel} / ${yLabel}`}
      aria-valuetext={`${xLabel} ${(x * 100) | 0}%, ${yLabel} ${(y * 100) | 0}%`}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        emit(e.clientX, e.clientY)
      }}
      onPointerMove={(e) => {
        if (dragging.current) emit(e.clientX, e.clientY)
      }}
      onPointerUp={(e) => {
        dragging.current = false
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      onPointerCancel={(e) => {
        // Touch cancel (e.g. gesture takeover) never fires pointerup; clear
        // drag so hover pointermove doesn't keep changing X/Y.
        dragging.current = false
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      onLostPointerCapture={() => {
        dragging.current = false
      }}
    >
      <div className="xypad__grid" />
      <div className="xypad__dot" style={{ left: `${x * 100}%`, top: `${(1 - y) * 100}%` }} />
      <span className="xypad__x">{xLabel}</span>
      <span className="xypad__y">{yLabel}</span>
    </div>
  )
}
