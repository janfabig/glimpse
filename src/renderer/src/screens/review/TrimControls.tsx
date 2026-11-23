import { useEffect, useRef } from 'react'
import { Crosshair, Minus, Plus, RotateCcw, type LucideIcon } from 'lucide-react'
import { Button, IconButton } from '../../components/ui/Button'
import { formatSeconds, tc } from '../../lib/format'
import type { TimeRange } from '../../lib/moments'

/** − / + of one edge: one step on press, then more while it is held */
function NudgeButton({
  icon,
  label,
  onStep,
  testId
}: {
  icon: LucideIcon
  label: string
  onStep: () => void
  testId: string
}): React.JSX.Element {
  // a repeat must step from the times of the latest render, not from those of the press
  const onStepRef = useRef(onStep)
  useEffect(() => {
    onStepRef.current = onStep
  })
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const stop = (): void => window.clearTimeout(timer.current)
  const repeat = (delay: number): void => {
    timer.current = window.setTimeout(() => {
      onStepRef.current()
      repeat(110)
    }, delay)
  }

  return (
    <IconButton
      icon={icon}
      size="sm"
      label={label}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        stop()
        event.currentTarget.setPointerCapture(event.pointerId)
        onStepRef.current()
        repeat(400)
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      // Enter on the focused button (detail 0; Space stays play/pause); a press has already stepped
      onClick={(event) => {
        if (event.detail === 0) onStepRef.current()
      }}
      data-testid={testId}
    />
  )
}

function Edge({
  label,
  value,
  onNudge,
  onSet,
  setLabel,
  ids,
  keys
}: {
  label: string
  value: number
  onNudge: (delta: number) => void
  onSet: () => void
  setLabel: string
  ids: { minus: string; plus: string; set: string }
  keys: { minus: string; plus: string }
}): React.JSX.Element {
  return (
    <div className="trim__edge" role="group" aria-label={label}>
      <span className="trim__label">{label}</span>
      <div className="trim__box">
        <NudgeButton
          icon={Minus}
          label={`${label} 0.5 s earlier (${keys.minus} key)`}
          onStep={() => onNudge(-0.5)}
          testId={ids.minus}
        />
        <span className="trim__value num">{tc(value, 1)}</span>
        <NudgeButton
          icon={Plus}
          label={`${label} 0.5 s later (${keys.plus} key)`}
          onStep={() => onNudge(0.5)}
          testId={ids.plus}
        />
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={Crosshair}
        onClick={onSet}
        title={setLabel}
        data-testid={ids.set}
      >
        Here
      </Button>
    </div>
  )
}

export function TrimControls({
  range,
  onNudge,
  onSetIn,
  onSetOut,
  onReset,
  canReset
}: {
  range: TimeRange
  onNudge: (edge: 'start' | 'end', delta: number) => void
  onSetIn: () => void
  onSetOut: () => void
  onReset: () => void
  canReset: boolean
}): React.JSX.Element {
  return (
    <div className="trim">
      <Edge
        label="Start"
        value={range.start}
        onNudge={(delta) => onNudge('start', delta)}
        onSet={onSetIn}
        setLabel="Set the start to the playhead (I key)"
        ids={{ minus: 'nudge-in-minus', plus: 'nudge-in-plus', set: 'set-in' }}
        keys={{ minus: ',', plus: '.' }}
      />
      <Edge
        label="End"
        value={range.end}
        onNudge={(delta) => onNudge('end', delta)}
        onSet={onSetOut}
        setLabel="Set the end to the playhead (O key)"
        ids={{ minus: 'nudge-out-minus', plus: 'nudge-out-plus', set: 'set-out' }}
        keys={{ minus: '-', plus: '+' }}
      />
      <span className="trim__length num" title="Clip length">
        {formatSeconds(range.end - range.start)}
      </span>
      <Button
        size="sm"
        variant="ghost"
        icon={RotateCcw}
        disabled={!canReset}
        onClick={onReset}
        title="Reset start and end to Gemini’s times"
        data-testid="reset-times"
      >
        Gemini’s times
      </Button>
    </div>
  )
}
