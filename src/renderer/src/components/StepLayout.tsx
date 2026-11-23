import type { ReactNode } from 'react'
import { cx } from '../lib/dom'

export function StepHeader({
  title,
  subtitle,
  aside
}: {
  title: string
  subtitle?: ReactNode
  aside?: ReactNode
}): React.JSX.Element {
  return (
    <header className="step__head">
      <div className="step__head-text">
        <h1 className="h1">{title}</h1>
        {subtitle && <p className="step__subtitle">{subtitle}</p>}
      </div>
      {aside && <div className="step__head-aside">{aside}</div>}
    </header>
  )
}

/** bottom bar: calm hint on the left, the step's actions (primary last) on the right */
export function StepFooter({
  hint,
  tone = 'info',
  children
}: {
  hint?: ReactNode
  tone?: 'info' | 'warning'
  children?: ReactNode
}): React.JSX.Element {
  return (
    <footer className="step__foot">
      <div className={cx('step__hint', tone === 'warning' && 'step__hint--warning')}>{hint}</div>
      <div className="step__actions">{children}</div>
    </footer>
  )
}
