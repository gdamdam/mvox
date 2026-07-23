// A/B comparison + numbered quick-recall slots. A/B holds two in-memory snapshots
// for instant compare; the numbered slots are a persisted bank recallable by click
// or MIDI program change. Presentational — App owns capture/recall/persist.

import type { SessionSnapshot } from '../persistence/session'
import type { SlotBank } from '../persistence/slots'

interface Props {
  ab: { a: SessionSnapshot | null; b: SessionSnapshot | null }
  onStoreAb: (slot: 'a' | 'b') => void
  onRecallAb: (slot: 'a' | 'b') => void
  slots: SlotBank
  storeMode: boolean
  onToggleStore: () => void
  onSlot: (i: number) => void
  onClearSlot: (i: number) => void
}

export function PerformanceSlots({ ab, onStoreAb, onRecallAb, slots, storeMode, onToggleStore, onSlot, onClearSlot }: Props) {
  return (
    <div className="slots">
      <div className="slots__ab" role="group" aria-label="A/B compare">
        <span className="slots__label">A/B</span>
        <button type="button" className="btn slots__set" onClick={() => onStoreAb('a')} title="Store the current sound + performance into A">
          Store A
        </button>
        <button type="button" className="btn" onClick={() => onRecallAb('a')} disabled={!ab.a} title="Recall A">
          A
        </button>
        <button type="button" className="btn slots__set" onClick={() => onStoreAb('b')} title="Store the current sound + performance into B">
          Store B
        </button>
        <button type="button" className="btn" onClick={() => onRecallAb('b')} disabled={!ab.b} title="Recall B">
          B
        </button>
      </div>

      <div className="slots__quick" role="group" aria-label="Quick recall slots">
        <span className="slots__label">Slots</span>
        <button
          type="button"
          className={storeMode ? 'btn btn--on' : 'btn'}
          aria-pressed={storeMode}
          onClick={onToggleStore}
          title="When on, clicking a slot SAVES the current state to it. Shift-click a slot to clear it."
        >
          ⤓ Store
        </button>
        {slots.map((snap, i) => (
          <button
            key={i}
            type="button"
            className={`btn slots__num ${snap ? 'slots__num--filled' : ''} ${storeMode ? 'slots__num--arm' : ''}`}
            onClick={(e) => (e.shiftKey ? onClearSlot(i) : onSlot(i))}
            disabled={!storeMode && !snap}
            title={snap ? `Slot ${i + 1} — click to recall (or PC ${i}); shift-click clears` : `Slot ${i + 1} — empty`}
          >
            {i + 1}
          </button>
        ))}
      </div>
    </div>
  )
}
