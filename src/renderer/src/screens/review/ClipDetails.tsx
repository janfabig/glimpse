import { CircleCheck, Plus, Star } from 'lucide-react'
import type { Moment, VideoInfo } from '@shared/types'
import { Button } from '../../components/ui/Button'

export function ClipDetails({
  moment,
  video,
  videoIndex,
  position,
  onAdd
}: {
  moment: Moment
  video: VideoInfo
  videoIndex: number
  /** 1-based position in the reel, null when not selected */
  position: number | null
  onAdd: () => void
}): React.JSX.Element {
  return (
    <div className="clip-details" data-testid="clip-details">
      <div className="clip-details__text">
        <p className="clip-details__source">
          Video {videoIndex + 1} · <span title={video.fileName}>{video.fileName}</span>
        </p>
        <div className="clip-details__title-row">
          <h2 className="clip-details__title">{moment.title}</h2>
          <span className="badge" title="How well the moment matches your prompt (1–10)">
            <Star size={11} fill="currentColor" /> {moment.score}/10
          </span>
        </div>
        <p className="clip-details__reason">{moment.reason}</p>
      </div>
      {position !== null ? (
        <span className="clip-details__state">
          <CircleCheck size={15} /> Clip {position} in the highlight video
        </span>
      ) : (
        <Button size="sm" icon={Plus} onClick={onAdd} data-testid="details-add">
          Add to the highlight video
        </Button>
      )}
    </div>
  )
}
