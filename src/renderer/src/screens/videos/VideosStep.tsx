import {
  ArrowRight,
  CircleCheck,
  Clock,
  Images,
  LoaderCircle,
  Plus,
  ShieldCheck,
  TriangleAlert,
  Upload
} from 'lucide-react'
import { formatDurationDe } from '@shared/time'
import type { Project } from '@shared/types'
import { StepFooter, StepHeader } from '../../components/StepLayout'
import { Button } from '../../components/ui/Button'
import { describePreviewFailures, prepareOverview } from '../../lib/analysis'
import { plural } from '../../lib/format'
import { goToStep, pickAndAddVideos } from '../../store/actions'
import { useApp } from '../../store/app-store'
import { ImportingCard } from './ImportingCard'
import { VideoCard } from './VideoCard'
import './videos.css'

const NO_IMPORTS: string[] = []

export function VideosStep({ project }: { project: Project }): React.JSX.Element {
  const importing = useApp((s) => s.imports[project.id] ?? NO_IMPORTS)
  const picking = useApp((s) => !!s.busy.pickVideos)
  const hasVideos = project.videos.length > 0
  const showGrid = hasVideos || importing.length > 0
  const prepare = prepareOverview(project)
  const totalSec = project.videos.reduce((sum, video) => sum + video.durationSec, 0)
  const preparing = prepare.running + prepare.pending

  return (
    <main className="step" data-screen="videos">
      <StepHeader
        title="Videos"
        subtitle="Drag your videos here or choose them. They are sorted by recording time automatically."
        aside={
          showGrid && (
            <Button
              icon={Plus}
              loading={picking}
              onClick={() => void pickAndAddVideos()}
              data-testid="add-videos"
            >
              Add videos
            </Button>
          )
        }
      />
      <div className="step__body">
        {showGrid ? (
          <div className="video-grid">
            {project.videos.map((video, index) => (
              <VideoCard key={video.id} project={project} video={video} index={index} />
            ))}
            {importing.map((path) => (
              <ImportingCard key={path} path={path} />
            ))}
            <button
              type="button"
              className="video-grid__add"
              disabled={picking}
              onClick={() => void pickAndAddVideos()}
              data-testid="add-more-videos"
            >
              <Plus size={22} />
              Add more videos
            </button>
          </div>
        ) : (
          <div className="dropzone">
            <span className="dropzone__icon" aria-hidden>
              <Upload size={30} strokeWidth={2} />
            </span>
            <h2 className="h2">Drag videos here</h2>
            <p className="dropzone__text">
              MP4 or MOV straight from your Meta glasses. 1–10 videos of up to 5 minutes each work
              best.
            </p>
            <Button
              variant="primary"
              size="lg"
              icon={Plus}
              loading={picking}
              onClick={() => void pickAndAddVideos()}
              data-testid="add-videos"
            >
              Choose videos
            </Button>
            <p className="dropzone__note">
              <ShieldCheck size={14} aria-hidden /> Your originals are never changed.
            </p>
            <p className="dropzone__note">
              <Images size={14} aria-hidden /> Videos from the Photos app: export them there first
              with File › Export › Export Unmodified Original.
            </p>
          </div>
        )}
      </div>
      <StepFooter
        tone={importing.length === 0 && preparing === 0 && prepare.failed > 0 ? 'warning' : 'info'}
        hint={
          importing.length > 0 ? (
            <>
              <LoaderCircle size={16} className="spin" />
              <span>
                Importing {plural(importing.length, 'video', 'videos')}. This usually takes only a
                few seconds.
              </span>
            </>
          ) : !hasVideos ? (
            <>
              <Clock size={16} /> Tip: ⌘-click to choose several videos at once.
            </>
          ) : preparing > 0 ? (
            <>
              <Clock size={16} />
              <span>
                Creating previews: {prepare.done} of {prepare.total} done, about 30–60 s per video.
                You can already go on with your prompt.
              </span>
            </>
          ) : prepare.failed > 0 ? (
            <>
              <TriangleAlert size={16} />
              <span data-testid="preview-failures">
                {describePreviewFailures(prepare.failed, prepare.withoutFilmstrip)}
              </span>
            </>
          ) : (
            <>
              <CircleCheck size={16} />
              <span>
                {plural(project.videos.length, 'video', 'videos')} · {formatDurationDe(totalSec)} of
                footage. Everything is ready.
              </span>
            </>
          )
        }
      >
        <Button
          variant="primary"
          iconRight={ArrowRight}
          disabled={!hasVideos}
          onClick={() => goToStep('brief')}
          data-testid="next-step"
        >
          Next: Prompt
        </Button>
      </StepFooter>
    </main>
  )
}
