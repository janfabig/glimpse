import type { BriefSettings } from '@shared/types'
import { Segmented } from '../../components/ui/controls'
import { formatTargetLabel, targetOptions } from '../../lib/brief'

/** what a new target length does to the highlight video in the Edit step */
function targetHint(target: number | null, reel: 'none' | 'automatic' | 'edited'): string {
  if (reel === 'edited') {
    return 'Your highlight video in the Edit step stays as you put it together. To apply a new length, use “Auto-select” there.'
  }
  if (reel === 'automatic') {
    return target === null
      ? 'All strong moments go in. Your highlight video in the Edit step adjusts automatically.'
      : 'Your highlight video in the Edit step adjusts to the new length automatically.'
  }
  return target === null
    ? 'All strong moments go in. The highlight video will be as long as it needs to be.'
    : 'Gemini picks the best moments to match. You can change everything in the Edit step.'
}

export function LengthSettings({
  brief,
  reel,
  onChange
}: {
  brief: BriefSettings
  /**
   * the reel in the Edit step: none yet · automatic (main selects again for a new target length) ·
   * edited by hand (it stays; "Auto-select" applies a new length)
   */
  reel: 'none' | 'automatic' | 'edited'
  onChange: (patch: Partial<BriefSettings>) => void
}): React.JSX.Element {
  const target = brief.targetDurationSec
  const options = targetOptions(target).map((value) => ({
    value,
    label: formatTargetLabel(value),
    testId: value === null ? 'target-none' : `target-${value}`
  }))

  return (
    <div className="field">
      <span className="field__label">Target length of the highlight video</span>
      <Segmented
        block
        wrap
        label="Target length"
        options={options}
        value={target}
        onChange={(value) => onChange({ targetDurationSec: value })}
      />
      <p className="field__hint" data-testid="target-hint">
        {targetHint(target, reel)}
      </p>
    </div>
  )
}
