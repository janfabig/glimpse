import type { ExportSettings, FitMode, VideoInfo } from '@shared/types'
import { Segmented } from '../../components/ui/controls'
import { cx } from '../../lib/dom'
import { ASPECT_OPTIONS, aspectRatioOf, mismatchedVideos } from '../../lib/export'
import { listDe } from '../../lib/format'

const FIT_OPTIONS: { value: FitMode; label: string; hint: string }[] = [
  { value: 'crop', label: 'Crop', hint: 'Fills the picture, the edges are cut off' },
  {
    value: 'blur',
    label: 'Blurred background',
    hint: 'Whole picture, the edges are filled with a blur'
  }
]

function AspectGlyph({
  ratio,
  dashed = false
}: {
  ratio: number
  dashed?: boolean
}): React.JSX.Element {
  const max = 34
  const width = ratio < 1 ? max * ratio : max
  const height = ratio < 1 ? max : max / ratio
  return (
    <span className="format-card__glyph" aria-hidden>
      <span className={cx('format-card__shape', dashed && 'is-dashed')} style={{ width, height }} />
    </span>
  )
}

export function ExportOptions({
  settings,
  source,
  reelVideos,
  disabled,
  onChange
}: {
  settings: ExportSettings
  /** first clip's video: decides the frame of "Original" */
  source: VideoInfo | null
  /** every video the reel uses, with its number in the project */
  reelVideos: { video: VideoInfo; number: number }[]
  disabled: boolean
  onChange: (patch: Partial<ExportSettings>) => void
}): React.JSX.Element {
  const candidates =
    reelVideos.length > 0 ? reelVideos.map((entry) => entry.video) : source ? [source] : []
  const mismatched = new Set(mismatchedVideos(settings.aspect, candidates))
  const sameShape = candidates.length > 0 && mismatched.size === 0
  const affected = reelVideos.filter((entry) => mismatched.has(entry.video))
  const partly = affected.length > 0 && affected.length < reelVideos.length

  return (
    <div className="export__options">
      <section className="export__section">
        <h2 className="h2">Format</h2>
        <div className="format-cards" role="radiogroup" aria-label="Format">
          {ASPECT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={settings.aspect === option.value}
              className="format-card"
              disabled={disabled}
              onClick={() => onChange({ aspect: option.value })}
              data-testid={`aspect-${option.value}`}
            >
              <AspectGlyph
                ratio={aspectRatioOf(option.value, source)}
                dashed={option.value === 'source'}
              />
              <span className="format-card__label">{option.label}</span>
              <span className="format-card__hint">{option.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="export__section">
        <h2 className="h2">Style</h2>
        <div className="export__grid">
          <div className="field">
            <span className="field__label">When the picture does not fit the format</span>
            <div
              className={cx('fit-options', sameShape && 'is-moot')}
              role="radiogroup"
              aria-label="Fit"
            >
              {FIT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={settings.fit === option.value}
                  className="fit-option"
                  disabled={disabled}
                  onClick={() => onChange({ fit: option.value })}
                  data-testid={`fit-${option.value}`}
                >
                  <span className={`fit-option__glyph is-${option.value}`} aria-hidden>
                    <span />
                  </span>
                  <span className="fit-option__text">
                    <span className="fit-option__label">{option.label}</span>
                    <span className="fit-option__hint">{option.hint}</span>
                  </span>
                </button>
              ))}
            </div>
            {sameShape && <p className="field__hint">Fits already. Nothing is cropped here.</p>}
            {partly && (
              <p className="field__hint" data-testid="fit-affected">
                Only affects the clips from {affected.length === 1 ? 'video' : 'videos'}{' '}
                {listDe(affected.map((entry) => String(entry.number)))}. The others fit already.
              </p>
            )}
          </div>
          <div className="field">
            <span className="field__label">Transition between clips</span>
            <Segmented
              block
              label="Transition"
              disabled={disabled}
              value={settings.transition}
              onChange={(transition) => onChange({ transition })}
              options={[
                { value: 'cut', label: 'Hard cut', testId: 'transition-cut' },
                { value: 'crossfade', label: 'Crossfade', testId: 'transition-crossfade' }
              ]}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
