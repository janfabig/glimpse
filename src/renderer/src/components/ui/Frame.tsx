import type { CSSProperties } from 'react'
import { Film } from 'lucide-react'
import type { VideoInfo } from '@shared/types'
import { cx } from '../../lib/dom'
import { imageSrc, spriteFrameStyle } from '../../lib/media'

/**
 * A still of `video`: the filmstrip frame at `time` when the sprite exists, else the poster,
 * else a neutral placeholder.
 */
export function Frame({
  video,
  time,
  width,
  height,
  className,
  style
}: {
  video: VideoInfo | null
  time?: number
  width: number
  height: number
  className?: string
  style?: CSSProperties
}): React.JSX.Element {
  const box: CSSProperties = { width, height, ...style }
  const sprite = video && time !== undefined ? spriteFrameStyle(video, time, width, height) : null
  if (sprite)
    return <span className={cx('frame', className)} style={{ ...box, ...sprite }} aria-hidden />
  const poster = video ? imageSrc(video.posterPath) : null
  return (
    <span className={cx('frame', className)} style={box} aria-hidden>
      {poster ? (
        <img src={poster} alt="" draggable={false} />
      ) : (
        <span className="frame__placeholder">
          <Film size={Math.min(20, Math.round(height / 2.5))} />
        </span>
      )}
    </span>
  )
}
