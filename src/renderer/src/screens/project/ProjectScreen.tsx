import { DropOverlay } from '../../components/FileDrop'
import { useFileDrop } from '../../components/use-file-drop'
import { TopBar } from '../../components/TopBar'
import type { StepId } from '../../lib/steps'
import { addVideoPaths, goToStep } from '../../store/actions'
import { useApp } from '../../store/app-store'
import { AnalysisStep } from '../analysis/AnalysisStep'
import { BriefStep } from '../brief/BriefStep'
import { ExportStep } from '../export/ExportStep'
import { ReviewStep } from '../review/ReviewStep'
import { VideosStep } from '../videos/VideosStep'
import { ProjectTitle } from './ProjectTitle'
import { Stepper } from './Stepper'

export function ProjectScreen({ step }: { step: StepId }): React.JSX.Element | null {
  const project = useApp((s) => s.project)
  const dragging = useFileDrop((paths) => void addVideoPaths(paths), !!project)
  if (!project) return null

  return (
    <div className="screen">
      <TopBar
        left={<ProjectTitle project={project} />}
        center={<Stepper project={project} current={step} onSelect={goToStep} />}
      />
      {step === 'videos' && <VideosStep project={project} />}
      {step === 'brief' && <BriefStep project={project} />}
      {step === 'analysis' && <AnalysisStep project={project} />}
      {step === 'review' && <ReviewStep key={project.id} project={project} />}
      {step === 'export' && <ExportStep project={project} />}
      {dragging && (
        <DropOverlay title="Add videos" text={`Drop them to add them to “${project.name}”.`} />
      )}
    </div>
  )
}
