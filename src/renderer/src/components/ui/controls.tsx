// Form controls: segmented control, progress bar.

import type { ReactNode } from 'react'
import { cx } from '../../lib/dom'

export interface SegmentedOption<T> {
  value: T
  label: ReactNode
  testId?: string
  title?: string
  disabled?: boolean
}

export function Segmented<T extends string | number | null>({
  options,
  value,
  onChange,
  label,
  block = false,
  wrap = false,
  disabled = false
}: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  label: string
  block?: boolean
  /** options that do not fit in one row continue in a second one */
  wrap?: boolean
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cx('segmented', block && 'segmented--block', wrap && 'segmented--wrap')}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="segmented__item"
          data-testid={option.testId}
          title={option.title}
          disabled={disabled || option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function ProgressBar({
  value,
  tone = 'accent',
  size = 'md',
  label
}: {
  /** 0..1, or null/negative for indeterminate */
  value: number | null
  tone?: 'accent' | 'success'
  size?: 'sm' | 'md' | 'lg'
  label?: string
}): React.JSX.Element {
  const indeterminate = value === null || value < 0
  const clamped = indeterminate ? 0 : Math.min(1, Math.max(0, value))
  return (
    <div
      className={cx(
        'progress',
        tone === 'success' && 'progress--success',
        size !== 'md' && `progress--${size}`,
        indeterminate && 'progress--indeterminate'
      )}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped * 100)}
    >
      <div
        className="progress__fill"
        style={indeterminate ? undefined : { width: `${clamped * 100}%` }}
      />
    </div>
  )
}
