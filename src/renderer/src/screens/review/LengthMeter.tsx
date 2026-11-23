import { formatDurationDe } from '@shared/time'
import { cx } from '../../lib/dom'
import { tc } from '../../lib/format'
import type { LengthStatus } from '../../lib/moments'

function stateText(status: LengthStatus): string {
  switch (status.state) {
    case 'free':
      return 'no limit'
    case 'fits':
      return 'fits'
    case 'under':
      return `${formatDurationDe(-status.delta)} left`
    case 'over':
      return `${formatDurationDe(status.delta)} too long`
  }
}

/** reel length vs. the brief's target */
export function LengthMeter({ status }: { status: LengthStatus }): React.JSX.Element {
  const fill = status.target ? Math.min(1, status.total / status.target) : 1
  return (
    <div
      className={cx('length-meter', `is-${status.state}`)}
      data-testid="total-duration"
      data-total-sec={status.total.toFixed(1)}
      title="Length of your highlight video (crossfades included)"
    >
      <span className="length-meter__row">
        <span className="length-meter__value num">
          {tc(status.total)}
          {status.target !== null && (
            <span className="length-meter__target"> / {tc(status.target)}</span>
          )}
        </span>
        <span className="length-meter__state">{stateText(status)}</span>
      </span>
      <span className="length-meter__bar" aria-hidden>
        <span style={{ width: `${fill * 100}%` }} />
      </span>
    </div>
  )
}
