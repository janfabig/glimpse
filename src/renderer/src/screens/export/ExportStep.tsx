import { useEffect } from 'react'
import { Clapperboard, Clock, FolderOpen, Home, RefreshCw, ShieldCheck } from 'lucide-react'
import type { ExportSettings, Project } from '@shared/types'
import { StepFooter, StepHeader } from '../../components/StepLayout'
import { Button } from '../../components/ui/Button'
import { estimateRenderSec, exportOutdated, isExportRunning } from '../../lib/export'
import { formatEstimate, shortenPath } from '../../lib/format'
import { effectiveLength } from '../../lib/moments'
import { clearExportProgress, goHome, mutate, startExport } from '../../store/actions'
import { useApp } from '../../store/app-store'
import { ExportOptions } from './ExportOptions'
import { ExportPanel } from './ExportPanel'
import './export.css'

export function ExportStep({ project }: { project: Project }): React.JSX.Element {
  const stored = useApp((s) => s.exportProgress[project.id])
  const basis = useApp((s) => s.exportBasis[project.id])
  const starting = useApp((s) => !!s.busy.startExport)
  const defaultDir = useApp((s) => s.settings?.defaultOutputDir ?? '')
  const settings = project.exportSettings
  const selected = project.moments.filter((m) => m.selected)
  // a finished export no longer describes the reel once clips, order or trims changed
  const outdated = exportOutdated(stored, basis, project)
  const progress = outdated ? undefined : stored
  const running = !!progress && isExportRunning(progress.phase)
  const done = progress?.phase === 'done'
  const outputDir = settings.outputDir ?? defaultDir
  // where the file went: the default folder may have been changed in the settings since then
  const savedDir = progress?.outputPath?.replace(/\/[^/]*$/, '') || outputDir

  useEffect(() => {
    if (outdated) clearExportProgress(project.id)
  }, [outdated, project.id])

  // the videos the reel uses, in reel order, with their number in the project
  const byId = new Map(project.videos.map((video, i) => [video.id, { video, number: i + 1 }]))
  const reelVideos = [...new Set(selected.map((m) => m.videoId))].flatMap(
    (id) => byId.get(id) ?? []
  )

  const update = (patch: Partial<ExportSettings>): void => {
    if (progress && !running) clearExportProgress(project.id)
    void mutate({ type: 'setExportSettings', patch })
  }

  const length = effectiveLength(selected, settings)
  const [low, high] = estimateRenderSec(settings, selected.length, length)

  return (
    <main className="step" data-screen="export">
      <StepHeader
        title="Export"
        subtitle="Choose format and style. Glimpse renders in full quality from your original videos."
      />
      <div className="step__body">
        <div className="export">
          <ExportOptions
            settings={settings}
            source={reelVideos[0]?.video ?? project.videos[0] ?? null}
            reelVideos={reelVideos}
            disabled={running}
            onChange={update}
          />
          <ExportPanel
            project={project}
            progress={progress}
            outputDir={outputDir}
            onResetDir={() => update({ outputDir: null })}
          />
        </div>
      </div>
      <StepFooter
        hint={
          running ? (
            <>
              <Clock size={16} />
              <span>Keep Glimpse open. You can do something else in the meantime.</span>
            </>
          ) : done ? (
            <>
              <FolderOpen size={16} />
              <span>Saved to {shortenPath(savedDir)}</span>
            </>
          ) : (
            <>
              <ShieldCheck size={16} />
              <span>
                Rendering takes {formatEstimate(low, high)}. Your originals are never changed.
              </span>
            </>
          )
        }
      >
        {done ? (
          <>
            <Button variant="ghost" icon={Home} onClick={goHome}>
              Back to home
            </Button>
            <Button
              icon={RefreshCw}
              loading={starting}
              onClick={() => void startExport()}
              data-testid="start-export"
            >
              Export again
            </Button>
          </>
        ) : running ? (
          <Button variant="primary" loading>
            Creating… {Math.round((progress?.progress ?? 0) * 100)}%
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={Clapperboard}
            disabled={selected.length === 0}
            loading={starting}
            onClick={() => void startExport()}
            data-testid="start-export"
          >
            Create highlight video
          </Button>
        )}
      </StepFooter>
    </main>
  )
}
