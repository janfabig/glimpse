import { CircleAlert, CircleCheck, FolderOpen, Play, Square } from 'lucide-react'
import { estimateExportBytes, outputSize } from '@shared/export-size'
import { EXPORT_FIXED } from '@shared/presets'
import { formatDurationDe } from '@shared/time'
import type {
  ExportProgress,
  ExportRecord,
  ExportSettings,
  Project,
  VideoInfo
} from '@shared/types'
import { Button, IconButton } from '../../components/ui/Button'
import { ProgressBar } from '../../components/ui/controls'
import { aspectRatioOf } from '../../lib/export'
import { fileNameOf, formatBytes, formatRelative, plural, shortenPath } from '../../lib/format'
import { imageSrc } from '../../lib/media'
import { effectiveLength } from '../../lib/moments'
import { cancelExport, chooseExportDir, shell } from '../../store/actions'

const PREVIEW_WIDTH = 280

/** the first clip's poster in the chosen format – shows how crop / blur will look */
function FormatPreview({
  settings,
  video,
  boxHeight
}: {
  settings: ExportSettings
  video: VideoInfo | null
  boxHeight: number
}): React.JSX.Element {
  const ratio = aspectRatioOf(settings.aspect, video)
  const fits = ratio < PREVIEW_WIDTH / boxHeight
  const width = fits ? boxHeight * ratio : PREVIEW_WIDTH
  const height = fits ? boxHeight : PREVIEW_WIDTH / ratio
  const poster = video ? imageSrc(video.posterPath) : null
  const mode = settings.aspect === 'source' ? 'source' : settings.fit
  return (
    <div className="format-preview" style={{ height: boxHeight }}>
      <div className={`format-preview__frame is-${mode}`} style={{ width, height }}>
        {poster && mode === 'blur' && (
          <img className="format-preview__backdrop" src={poster} alt="" />
        )}
        {poster && <img className="format-preview__image" src={poster} alt="" />}
      </div>
    </div>
  )
}

function Progress({ progress }: { progress: ExportProgress }): React.JSX.Element {
  const percent = Math.round(progress.progress * 100)
  return (
    <div className="export-progress" data-testid="export-progress" data-phase={progress.phase}>
      <div className="export-progress__row">
        <span className="export-progress__label">{progress.message ?? 'Creating…'}</span>
        <span className="export-progress__percent num">{percent}%</span>
      </div>
      <ProgressBar value={progress.progress} size="lg" label="Export" />
      <div className="export-progress__actions">
        <Button
          size="sm"
          variant="ghost"
          icon={Square}
          onClick={() => void cancelExport()}
          data-testid="cancel-export"
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

function Done({
  progress,
  record
}: {
  progress: ExportProgress
  record: ExportRecord | null
}): React.JSX.Element {
  const path = record?.path ?? progress.outputPath ?? ''
  return (
    <div className="export-done" data-testid="export-done">
      <span className="export-done__icon" aria-hidden>
        <CircleCheck size={28} strokeWidth={2.2} />
      </span>
      <p className="export-done__title">Done! Your highlight video is saved.</p>
      <p className="export-done__file" title={path} data-selectable>
        {fileNameOf(path)}
      </p>
      {record && (
        <p className="export-done__meta num">
          {formatDurationDe(record.durationSec)} · {plural(record.clipCount, 'clip', 'clips')} ·{' '}
          {formatBytes(record.sizeBytes)}
        </p>
      )}
      <div className="export-done__actions">
        <Button
          variant="primary"
          icon={Play}
          onClick={() => void shell.openFile(path)}
          data-testid="open-output"
        >
          Play
        </Button>
        <Button
          icon={FolderOpen}
          onClick={() => void shell.showInFinder(path)}
          data-testid="show-in-finder"
        >
          Show in Finder
        </Button>
      </div>
    </div>
  )
}

function History({ records }: { records: ExportRecord[] }): React.JSX.Element {
  return (
    <section className="export-history" aria-label="Earlier exports">
      <h3 className="export-history__title">Earlier exports</h3>
      <ul>
        {records.map((record) => (
          <li key={record.id} className="export-history__item" data-testid="export-record">
            <div className="export-history__text">
              <span className="export-history__name" title={record.path}>
                {fileNameOf(record.path)}
              </span>
              <span className="export-history__meta num">
                {formatRelative(record.createdAt)} · {formatDurationDe(record.durationSec)} ·{' '}
                {formatBytes(record.sizeBytes)}
              </span>
            </div>
            <IconButton
              icon={Play}
              size="sm"
              label="Play"
              onClick={() => void shell.openFile(record.path)}
            />
            <IconButton
              icon={FolderOpen}
              size="sm"
              label="Show in Finder"
              onClick={() => void shell.showInFinder(record.path)}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ExportPanel({
  project,
  progress,
  outputDir,
  onResetDir
}: {
  project: Project
  progress: ExportProgress | undefined
  outputDir: string
  onResetDir: () => void
}): React.JSX.Element {
  const settings = project.exportSettings
  const selected = project.moments.filter((m) => m.selected)
  const firstVideo =
    project.videos.find((v) => v.id === selected[0]?.videoId) ?? project.videos[0] ?? null
  const length = effectiveLength(selected, settings)
  const size = outputSize(settings.aspect, firstVideo)
  const phase = progress?.phase
  const running =
    phase === 'preparing' || phase === 'rendering' || phase === 'joining' || phase === 'finishing'
  const doneRecord =
    phase === 'done' ? (project.exports.find((e) => e.path === progress?.outputPath) ?? null) : null
  const history = [...project.exports].reverse().filter((record) => record.id !== doneRecord?.id)

  return (
    <aside className="export__aside">
      <section className="export-panel" data-testid="export-panel">
        <FormatPreview
          settings={settings}
          video={firstVideo}
          boxHeight={phase === 'done' ? 150 : 230}
        />
        {phase === 'done' && progress ? (
          <Done progress={progress} record={doneRecord} />
        ) : running && progress ? (
          <Progress progress={progress} />
        ) : (
          <>
            <dl className="export-facts">
              <div>
                <dt>Content</dt>
                <dd className="num">
                  {plural(selected.length, 'clip', 'clips')} · {formatDurationDe(length)}
                </dd>
              </div>
              <div>
                <dt>Picture</dt>
                <dd className="num">
                  {size.width} × {size.height} · {EXPORT_FIXED.fps} fps
                </dd>
              </div>
              <div>
                <dt>File</dt>
                <dd className="num">
                  H.264 · about{' '}
                  {formatBytes(estimateExportBytes(settings.aspect, firstVideo, length))}
                </dd>
              </div>
              <div>
                <dt>Folder</dt>
                <dd title={outputDir}>{shortenPath(outputDir)}</dd>
              </div>
            </dl>
            <div className="export-dir">
              {settings.outputDir && (
                <button
                  type="button"
                  className="link"
                  onClick={onResetDir}
                  data-testid="reset-output-dir"
                >
                  Default folder
                </button>
              )}
              <button
                type="button"
                className="link"
                onClick={() => void chooseExportDir()}
                data-testid="choose-output-dir"
              >
                <FolderOpen size={13} /> Choose another folder
              </button>
            </div>
            {phase === 'error' && (
              <p className="export-error" data-testid="export-error">
                <CircleAlert size={16} />
                <span>{progress?.error ?? 'The export failed.'}</span>
              </p>
            )}
            {phase === 'cancelled' && <p className="export-note">Export cancelled.</p>}
          </>
        )}
      </section>
      {history.length > 0 && <History records={history} />}
    </aside>
  )
}
