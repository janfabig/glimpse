import {
  CircleCheck,
  Film,
  Play,
  RotateCcw,
  Settings,
  Sparkles,
  Square,
  TriangleAlert
} from 'lucide-react'
import { formatDurationDe } from '@shared/time'
import type { Project } from '@shared/types'
import { Button } from '../../components/ui/Button'
import { ProgressBar } from '../../components/ui/controls'
import {
  estimateRemainingSec,
  failureOverview,
  formatRemaining,
  type AnalysisOverview,
  type FailureOverview
} from '../../lib/analysis'
import { plural } from '../../lib/format'
import { cancelAnalysis, goToStep, openSettings, startAnalysis } from '../../store/actions'
import { useApp } from '../../store/app-store'

/**
 * The buttons of the failure card: retry what can work, else the place that can help – the
 * settings (key, model, quota, billing; next to them the retry for once that is fixed) or the
 * Videos step (previews).
 */
function FailureButton({
  failures,
  starting
}: {
  failures: FailureOverview
  starting: boolean
}): React.JSX.Element | null {
  const { failedIds, retryIds, settingsIds, remedies } = failures
  // trying again helps right away – or, for the settings' videos, once the settings are fixed
  const retryable = failedIds.filter((id) => retryIds.includes(id) || settingsIds.includes(id))
  const retry = (variant: 'secondary' | 'ghost'): React.JSX.Element => (
    <Button
      variant={variant}
      icon={RotateCcw}
      loading={starting}
      onClick={() => void startAnalysis({ videoIds: retryable })}
      data-testid="retry-failed"
    >
      {retryable.length === failedIds.length
        ? 'Retry failed videos'
        : `Retry ${plural(retryable.length, 'video', 'videos')}`}
    </Button>
  )
  if (settingsIds.length > 0) {
    return (
      <div className="analysis-summary__actions">
        <Button icon={Settings} onClick={openSettings} data-testid="failed-open-settings">
          Open Settings
        </Button>
        {retry('ghost')}
      </div>
    )
  }
  if (retryIds.length > 0) return retry('secondary')
  if (remedies.includes('prepare')) {
    return (
      <Button icon={Film} onClick={() => goToStep('videos')} data-testid="failed-go-videos">
        Go to Videos
      </Button>
    )
  }
  return null
}

/** the big status card on top: progress while running, outcome afterwards */
export function AnalysisSummary({
  project,
  overview
}: {
  project: Project
  overview: AnalysisOverview
}): React.JSX.Element {
  const starting = useApp((s) => !!s.busy.startAnalysis)
  const selected = project.moments.filter((m) => m.selected).length
  const target = project.brief.targetDurationSec

  if (overview.active) {
    const remaining = estimateRemainingSec(project)
    return (
      <section className="analysis-summary is-running" data-testid="analysis-summary">
        <span className="analysis-summary__icon" aria-hidden>
          <Sparkles size={24} />
        </span>
        <div className="analysis-summary__main">
          <div className="analysis-summary__title-row">
            <h2 className="h2">Gemini is analysing your videos…</h2>
            <span className="analysis-summary__count num">
              {overview.done} of {overview.total} done
            </span>
          </div>
          <ProgressBar value={overview.fraction} size="lg" label="Overall progress" />
          <p className="analysis-summary__text">
            {remaining !== null ? formatRemaining(remaining) : 'Starting soon'}
            {overview.momentCount > 0 &&
              ` · ${plural(overview.momentCount, 'moment', 'moments')} found so far`}
            {overview.failed > 0 &&
              ` · ${plural(overview.failed, 'video', 'videos')} failed, see below`}
          </p>
        </div>
        <Button icon={Square} onClick={() => void cancelAnalysis()} data-testid="cancel-analysis">
          Cancel
        </Button>
      </section>
    )
  }

  if (overview.failed > 0 || overview.cancelled > 0) {
    const cancelled = overview.cancelled > 0 && overview.failed === 0
    const failures = failureOverview(project)
    const progress =
      overview.done > 0
        ? overview.momentCount > 0
          ? `${plural(overview.done, 'video is', 'videos are')} analysed. With ${plural(overview.momentCount, 'moment', 'moments')} you can already go to the Edit step.`
          : `${plural(overview.done, 'video is', 'videos are')} analysed. Gemini found no matching moments there.`
        : cancelled || failures.retryIds.length > 0
          ? 'No results yet. Try again.'
          : 'No results yet.'
    return (
      <section className="analysis-summary is-warning" data-testid="analysis-summary">
        <span className="analysis-summary__icon" aria-hidden>
          <TriangleAlert size={24} />
        </span>
        <div className="analysis-summary__main">
          <h2 className="h2">
            {cancelled
              ? 'Analysis cancelled'
              : `${plural(overview.failed, 'video', 'videos')} failed`}
          </h2>
          {!cancelled && (
            <p className="analysis-summary__reason" data-testid="analysis-failure-reason">
              {failures.sharedReason ?? 'You can find the reasons below, next to each video.'}
            </p>
          )}
          <p className="analysis-summary__text">{progress}</p>
        </div>
        {cancelled ? (
          <Button
            icon={Play}
            loading={starting}
            onClick={() => void startAnalysis()}
            data-testid="resume-analysis"
          >
            Continue
          </Button>
        ) : (
          <FailureButton failures={failures} starting={starting} />
        )}
      </section>
    )
  }

  if (overview.done > 0 && overview.momentCount === 0) {
    // "Go to Edit" stays disabled without moments: the way on is another prompt
    return (
      <section className="analysis-summary is-warning" data-testid="analysis-summary">
        <span className="analysis-summary__icon" aria-hidden>
          <TriangleAlert size={24} />
        </span>
        <div className="analysis-summary__main">
          <h2 className="h2">Gemini found no matching moments</h2>
          <p className="analysis-summary__text">Change your prompt and analyse again.</p>
        </div>
        <Button onClick={() => goToStep('brief')} data-testid="nothing-found-go-brief">
          Go to Prompt
        </Button>
      </section>
    )
  }

  if (overview.done > 0) {
    return (
      <section className="analysis-summary is-done" data-testid="analysis-summary">
        <span className="analysis-summary__icon" aria-hidden>
          <CircleCheck size={24} />
        </span>
        <div className="analysis-summary__main">
          <h2 className="h2">
            Done! {plural(overview.momentCount, 'moment', 'moments')} found in{' '}
            {plural(overview.done, 'video', 'videos')}
          </h2>
          <p className="analysis-summary__text">
            {project.reelEdited && selected > 0
              ? 'Your highlight video stays as you put it together in the Edit step. You’ll find new moments there under “More suggestions”.'
              : selected > 0
                ? `${plural(selected, 'of them is', 'of them are')} already selected ${target ? `to match the target length of ${formatDurationDe(target)}` : 'for your highlight video'}. You can change everything in the Edit step.`
                : 'In the Edit step you choose which moments go into the highlight video.'}
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="analysis-summary" data-testid="analysis-summary">
      <span className="analysis-summary__icon" aria-hidden>
        <Sparkles size={24} />
      </span>
      <div className="analysis-summary__main">
        <h2 className="h2">Not analysed yet</h2>
        <p className="analysis-summary__text">
          Start the analysis so that Gemini can suggest moments.
        </p>
      </div>
      <Button
        variant="primary"
        icon={Sparkles}
        loading={starting}
        onClick={() => void startAnalysis()}
      >
        Start analysis
      </Button>
    </section>
  )
}
