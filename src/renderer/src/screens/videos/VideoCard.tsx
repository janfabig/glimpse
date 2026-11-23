import { useState } from 'react'
import {
  CircleAlert,
  CircleCheck,
  Film,
  LoaderCircle,
  Play,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react'
import type { Project, VideoInfo } from '@shared/types'
import { Button, IconButton } from '../../components/ui/Button'
import { ProgressBar } from '../../components/ui/controls'
import { ConfirmDialog } from '../../components/ui/Modal'
import { isRepeatClick } from '../../lib/click-guard'
import { cx } from '../../lib/dom'
import { formatBytes, formatRecordedAt, tc } from '../../lib/format'
import { imageSrc } from '../../lib/media'
import { isMissingOriginal, videoRemovalMessage } from '../../lib/project'
import { removeVideo, retryPrepare, shell } from '../../store/actions'
import { itemKey, useApp } from '../../store/app-store'

export function VideoCard({
  project,
  video,
  index
}: {
  project: Project
  video: VideoInfo
  index: number
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  // main is removing it: no second removal, no clicks that land on the next card
  const removing = useApp((s) => !!s.pending[itemKey.video(video.id)])
  const prepare = project.status[video.id]?.prepare ?? { status: 'pending', progress: 0 }
  const poster = imageSrc(video.posterPath)
  const momentCount = project.moments.filter((m) => m.videoId === video.id).length
  const portrait = video.height >= video.width
  const originalGone = prepare.status === 'error' && isMissingOriginal(prepare.error)

  const requestRemove = (): void => {
    if (removing) return
    if (momentCount > 0) setConfirming(true)
    else void removeVideo(video.id)
  }

  return (
    <article
      className={cx('video-card', removing && 'is-removing')}
      data-testid="video-card"
      data-prepare={prepare.status}
      aria-busy={removing || undefined}
    >
      <div className={portrait ? 'video-card__media' : 'video-card__media is-landscape'}>
        <button
          type="button"
          className="video-card__play"
          title="Play original"
          aria-label="Play original"
          disabled={removing || originalGone}
          onClick={(event) => {
            // a Finder-style double click must not open the original twice
            if (!isRepeatClick(event)) void shell.openOriginal(project.id, video.id)
          }}
          data-testid="video-play"
        >
          {poster ? (
            <img src={poster} alt="" draggable={false} />
          ) : (
            <span className="video-card__placeholder">
              <Film size={28} strokeWidth={1.8} />
            </span>
          )}
          <span className="video-card__play-icon" aria-hidden="true">
            <Play size={20} fill="currentColor" />
          </span>
        </button>
        <span className="badge badge--solid video-card__index">{index + 1}</span>
        <span className="badge badge--solid video-card__duration num">{tc(video.durationSec)}</span>
        <IconButton
          className="video-card__remove"
          icon={X}
          size="sm"
          label="Remove video"
          disabled={removing}
          onClick={(event) => {
            // the grid reflows right away: a double click must not remove the next video too
            if (!isRepeatClick(event)) requestRemove()
          }}
          data-testid="remove-video"
        />
      </div>
      <div className="video-card__body">
        <p className="video-card__name" title={video.fileName}>
          {video.fileName}
        </p>
        <p className="video-card__meta">{formatRecordedAt(video.recordedAt)}</p>
        <div className="video-card__status">
          {prepare.status === 'done' && (
            <span className="video-card__state is-done">
              <CircleCheck size={14} />
              <span className="video-card__state-text">Ready · {formatBytes(video.sizeBytes)}</span>
            </span>
          )}
          {prepare.status === 'running' && (
            <>
              <span className="video-card__state">
                <span className="video-card__state-text">Creating preview</span>
                <span className="video-card__percent num">
                  {Math.round(prepare.progress * 100)}%
                </span>
              </span>
              <ProgressBar value={prepare.progress} size="sm" label="Preview" />
            </>
          )}
          {prepare.status === 'pending' && (
            <span className="video-card__state is-waiting">
              <LoaderCircle size={14} />
              <span className="video-card__state-text">Waiting for preview…</span>
            </span>
          )}
          {prepare.status === 'error' && (
            <>
              <span
                className="video-card__state is-error"
                title={prepare.error}
                data-testid="prepare-error"
              >
                <CircleAlert size={14} />
                <span className="video-card__error-text">
                  {/* the file name is right above: the short form fits the card */}
                  {originalGone
                    ? 'Original file not found. Was it moved? Add it again.'
                    : (prepare.error ?? 'The preview could not be created.')}
                </span>
              </span>
              <div className="video-card__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={RotateCcw}
                  disabled={removing}
                  onClick={() => void retryPrepare(video.id)}
                  data-testid="retry-prepare"
                >
                  {originalGone ? 'Check again' : 'Try again'}
                </Button>
                {originalGone && (
                  <Button
                    size="sm"
                    variant="danger"
                    icon={Trash2}
                    disabled={removing}
                    onClick={(event) => {
                      if (!isRepeatClick(event)) requestRemove()
                    }}
                    data-testid="remove-missing-video"
                  >
                    Remove
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Remove video?"
          message={videoRemovalMessage(project, video)}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            void removeVideo(video.id)
          }}
        />
      )}
    </article>
  )
}
