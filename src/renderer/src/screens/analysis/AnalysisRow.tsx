import { Check, Film, ImagePlus, RotateCcw, Settings, Sparkles } from 'lucide-react'
import type { AnalysisStage, Project, VideoInfo } from '@shared/types'
import { Button } from '../../components/ui/Button'
import { Frame } from '../../components/ui/Frame'
import { failureAction, failureText, isRunningStage } from '../../lib/analysis'
import { cx } from '../../lib/dom'
import { formatClock, tc } from '../../lib/format'
import { goToStep, openSettings, rebuildPreview, startAnalysis } from '../../store/actions'
import { useApp } from '../../store/app-store'

const PIPELINE: { stage: AnalysisStage; label: string }[] = [
  { stage: 'waiting-proxy', label: 'Preview' },
  { stage: 'uploading', label: 'Upload' },
  { stage: 'processing', label: 'Processing' },
  { stage: 'analyzing', label: 'Analysis' }
]

const ORDER: AnalysisStage[] = [
  'queued',
  'waiting-proxy',
  'uploading',
  'processing',
  'analyzing',
  'done'
]

const DEFAULT_TEXT: Partial<Record<AnalysisStage, string>> = {
  idle: 'Not analysed yet',
  queued: 'Queued',
  'waiting-proxy': 'Waiting for the preview…',
  uploading: 'Uploading…',
  processing: 'Gemini is processing the video…',
  analyzing: 'Gemini is looking for the best moments…',
  done: 'Done',
  cancelled: 'Cancelled'
}

function Pipeline({ stage }: { stage: AnalysisStage }): React.JSX.Element {
  const position = ORDER.indexOf(stage)
  return (
    <ol className="pipeline" aria-hidden>
      {PIPELINE.map((step) => {
        const index = ORDER.indexOf(step.stage)
        const state =
          stage === 'done' || (position > index && position >= 0)
            ? 'done'
            : stage === step.stage
              ? 'active'
              : 'todo'
        return (
          <li key={step.stage} className={cx('pipeline__step', `is-${state}`)}>
            <span className="pipeline__dot">
              {state === 'done' && <Check size={10} strokeWidth={3.5} />}
            </span>
            <span className="pipeline__label">{step.label}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function AnalysisRow({
  project,
  video,
  index
}: {
  project: Project
  video: VideoInfo
  index: number
}): React.JSX.Element {
  const starting = useApp((s) => !!s.busy.startAnalysis)
  const analysis = project.status[video.id]?.analysis ?? { stage: 'idle' as const, progress: 0 }
  const { stage } = analysis
  const running = isRunningStage(stage)
  const base =
    stage === 'error'
      ? failureText(project, video.id)
      : (analysis.message ?? DEFAULT_TEXT[stage] ?? '')
  const showPercent =
    running && analysis.progress >= 0 && stage !== 'processing' && stage !== 'queued'
  const text = showPercent ? `${base} ${Math.round(analysis.progress * 100)}%` : base
  // what can help with a failed or cancelled video (main's remedy)
  const action =
    stage === 'error' || stage === 'cancelled' ? failureAction(project, video.id) : null

  return (
    <li className={cx('analysis-row', `is-${stage}`)} data-testid="analysis-row" data-stage={stage}>
      <Frame video={video} width={42} height={56} className="analysis-row__thumb" />
      <div className="analysis-row__info">
        <p className="analysis-row__name">
          <span className="analysis-row__index">Video {index + 1}</span>
          <span className="analysis-row__file" title={video.fileName}>
            {video.fileName}
          </span>
        </p>
        <p className="analysis-row__status" title={text}>
          {stage === 'done' && <Check size={14} strokeWidth={3} />}
          <span>{text}</span>
          <span className="analysis-row__meta num">
            {tc(video.durationSec)}
            {video.recordedAt && ` · ${formatClock(video.recordedAt)}`}
          </span>
        </p>
      </div>
      {stage !== 'idle' && stage !== 'error' && stage !== 'cancelled' && <Pipeline stage={stage} />}
      <div className="analysis-row__action">
        {action === 'retry' && (
          <Button
            size="sm"
            icon={RotateCcw}
            disabled={starting}
            onClick={() => void startAnalysis({ videoIds: [video.id] })}
            data-testid="retry-analysis"
          >
            Try again
          </Button>
        )}
        {action === 'settings' && (
          <>
            <Button
              size="sm"
              icon={Settings}
              onClick={openSettings}
              data-testid="analysis-open-settings"
            >
              Open Settings
            </Button>
            {/* once the settings are fixed (another model, a new key, billing) – or the next day */}
            <Button
              size="sm"
              variant="ghost"
              icon={RotateCcw}
              disabled={starting}
              onClick={() => void startAnalysis({ videoIds: [video.id] })}
              data-testid="retry-analysis"
            >
              Try again
            </Button>
          </>
        )}
        {action === 'rebuild-preview' && (
          <Button
            size="sm"
            icon={ImagePlus}
            disabled={starting}
            onClick={() => void rebuildPreview(video.id)}
            data-testid="rebuild-preview"
          >
            Recreate preview
          </Button>
        )}
        {action === 'go-videos' && (
          <Button
            size="sm"
            icon={Film}
            onClick={() => goToStep('videos')}
            data-testid="analysis-go-videos"
          >
            Go to Videos
          </Button>
        )}
        {stage === 'idle' && (
          <Button
            size="sm"
            icon={Sparkles}
            disabled={starting}
            onClick={() => void startAnalysis({ videoIds: [video.id] })}
            data-testid="analyze-video"
          >
            Analyse
          </Button>
        )}
        {running && <span className="analysis-row__spinner" aria-label="running" />}
      </div>
    </li>
  )
}
