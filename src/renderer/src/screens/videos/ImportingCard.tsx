import { LoaderCircle } from 'lucide-react'
import { fileNameOf } from '../../lib/format'

/** placeholder while main probes a file and renders its poster */
export function ImportingCard({ path }: { path: string }): React.JSX.Element {
  const name = fileNameOf(path)
  return (
    <article className="video-card is-importing" data-testid="video-importing" aria-busy>
      <div className="video-card__media">
        <span className="video-card__placeholder">
          <LoaderCircle size={26} strokeWidth={2} className="spin" aria-hidden />
        </span>
      </div>
      <div className="video-card__body">
        <p className="video-card__name" title={name}>
          {name}
        </p>
        <p className="video-card__meta">Importing…</p>
      </div>
    </article>
  )
}
