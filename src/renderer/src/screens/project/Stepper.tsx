import { Fragment } from 'react'
import { Check } from 'lucide-react'
import type { Project } from '@shared/types'
import { cx } from '../../lib/dom'
import { STEPS, stepAvailability, stepCompletion, type StepId } from '../../lib/steps'

export function Stepper({
  project,
  current,
  onSelect
}: {
  project: Project
  current: StepId
  onSelect: (step: StepId) => void
}): React.JSX.Element {
  const available = stepAvailability(project)
  const done = stepCompletion(project)
  return (
    <nav className="stepper" aria-label="Steps">
      {STEPS.map((step, index) => {
        const isCurrent = step.id === current
        const isDone = done[step.id] && !isCurrent
        return (
          <Fragment key={step.id}>
            {index > 0 && (
              <span
                className={cx('stepper__line', done[STEPS[index - 1].id] && 'is-done')}
                aria-hidden
              />
            )}
            <button
              type="button"
              className={cx('stepper__step', isCurrent && 'is-current', isDone && 'is-done')}
              disabled={!available[step.id] && !isCurrent}
              aria-current={isCurrent ? 'step' : undefined}
              onClick={() => onSelect(step.id)}
              data-testid={`step-${step.id}`}
            >
              <span className="stepper__dot">
                {isDone ? <Check size={12} strokeWidth={3} /> : index + 1}
              </span>
              {step.label}
            </button>
          </Fragment>
        )
      })}
    </nav>
  )
}
