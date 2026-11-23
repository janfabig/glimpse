import { ArrowRight, Clock, Coffee } from 'lucide-react'
import type { Project } from '@shared/types'
import { StepFooter, StepHeader } from '../../components/StepLayout'
import { Button } from '../../components/ui/Button'
import { analysisOverview, reelKeptAfterRun } from '../../lib/analysis'
import { goToStep } from '../../store/actions'
import { AnalysisRow } from './AnalysisRow'
import { AnalysisSummary } from './AnalysisSummary'
import './analysis.css'

export function AnalysisStep({ project }: { project: Project }): React.JSX.Element {
  const overview = analysisOverview(project)
  const canReview = project.moments.length > 0

  return (
    <main className="step" data-screen="analysis">
      <StepHeader
        title="Analysis"
        subtitle="Gemini watches every video and marks the best moments. You don’t have to do anything."
      />
      <div className="step__body">
        <div className="analysis">
          <AnalysisSummary project={project} overview={overview} />
          <ul className="analysis__list" aria-label="Videos">
            {project.videos.map((video, index) => (
              <AnalysisRow key={video.id} project={project} video={video} index={index} />
            ))}
          </ul>
        </div>
      </div>
      <StepFooter
        hint={
          overview.active ? (
            <>
              <Coffee size={16} />
              <span>
                {reelKeptAfterRun(project)
                  ? 'Time for a coffee. Your selection in the Edit step stays, and you’ll find the new moments under “More suggestions” afterwards.'
                  : 'Time for a coffee. When everything is done, the app puts your highlight video together automatically.'}
              </span>
            </>
          ) : (
            <>
              <Clock size={16} />
              <span>
                {canReview
                  ? 'In the Edit step you review the suggestions, trim clips and put them in order.'
                  : overview.done > 0
                    ? 'Without moments there is nothing to edit. Change your prompt and analyse again.'
                    : 'As soon as moments are found, you can go on in the Edit step.'}
              </span>
            </>
          )
        }
      >
        <Button
          variant="primary"
          iconRight={ArrowRight}
          disabled={!canReview}
          onClick={() => goToStep('review')}
          data-testid="go-review"
        >
          Go to Edit
        </Button>
      </StepFooter>
    </main>
  )
}
