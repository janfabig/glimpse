import { ArrowRight, Clock, Lightbulb, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'
import { ANALYSIS_PARALLEL, LIMITS } from '@shared/presets'
import type { BriefSettings, Project } from '@shared/types'
import { StepFooter, StepHeader } from '../../components/StepLayout'
import { Button } from '../../components/ui/Button'
import { ANALYSIS_SEC_PER_VIDEO, analysisOverview } from '../../lib/analysis'
import { analysisPlan } from '../../lib/brief'
import { costHint, freeQuotaWarning } from '../../lib/cost'
import { formatEstimate, plural } from '../../lib/format'
import { goToStep, mutate, openSettings, startAnalysis, toast } from '../../store/actions'
import { useApp } from '../../store/app-store'
import { LengthSettings } from './LengthSettings'
import { useBriefHash, useDraft } from './use-brief'
import './brief.css'

export function BriefStep({ project }: { project: Project }): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const starting = useApp((s) => !!s.busy.startAnalysis)
  const brief = project.brief
  const projectId = project.id
  const setBrief = (patch: Partial<BriefSettings>): Promise<unknown> =>
    mutate({ type: 'setBrief', patch }, projectId)
  const prompt = useDraft(brief.prompt, (next) => setBrief({ prompt: next }))
  const hash = useBriefHash(brief, settings?.model)
  // videos whose preview failed never reach Gemini: they are not counted or estimated
  const plan = analysisPlan(project, hash)
  const running = analysisOverview(project).active
  const needsKey = !!settings && !settings.hasApiKey && !settings.fakeAi
  const videoCount = project.videos.length
  const allFresh = hash !== null && plan.toAnalyse === 0 && plan.fresh > 0
  /** only videos without a preview are left: nothing Gemini could look at */
  const onlyWithoutPreview = plan.toAnalyse === 0 && plan.fresh === 0 && plan.withoutPreview > 0
  const toAnalyse = plan.toAnalyse
  const quotaWarning = freeQuotaWarning(settings?.model, toAnalyse)
  const cost = costHint(settings?.model)
  const skipped =
    plan.withoutPreview > 0
      ? plan.withoutPreview === 1
        ? ' · 1 video without a preview is skipped'
        : ` · ${plan.withoutPreview} videos without a preview are skipped`
      : ''
  const reel = project.reelEdited ? 'edited' : project.moments.length > 0 ? 'automatic' : 'none'

  const start = async (force = false): Promise<void> => {
    if (needsKey) {
      toast(
        'warning',
        settings?.apiKeyUnreadable
          ? 'Your saved API key can no longer be read. Paste it again in Settings.'
          : 'Connect Gemini first. Then the analysis can start.'
      )
      openSettings()
      return
    }
    if (!prompt.draft.trim()) {
      toast('warning', 'Write a few words about what Gemini should look for.')
      return
    }
    await prompt.flush()
    await startAnalysis(force ? { force: true } : undefined)
  }

  const [low, high] = ANALYSIS_SEC_PER_VIDEO
  const rounds = Math.ceil(Math.max(1, toAnalyse) / ANALYSIS_PARALLEL)
  const estimate = formatEstimate(low * rounds, high * rounds)

  return (
    <main className="step" data-screen="brief">
      <StepHeader
        title="Prompt"
        subtitle="Tell Gemini what to look for. The more specific you are, the better the suggestions fit."
      />
      <div className="step__body">
        <div className="brief">
          <section className="brief__section">
            <div className="section-head">
              <h2 className="h2">
                <label htmlFor="brief-prompt">Your prompt</label>
              </h2>
              <span className="section-head__aside num">
                {prompt.draft.length} characters
                {prompt.draft.length >= LIMITS.promptMax && ', the maximum'}
              </span>
            </div>
            <textarea
              id="brief-prompt"
              className="textarea brief__textarea"
              value={prompt.draft}
              rows={9}
              // main keeps no more: what is typed beyond would be cut away without a word
              maxLength={LIMITS.promptMax}
              placeholder="Describe what should go into the highlight video and what can be left out…"
              onChange={(event) => prompt.change(event.target.value)}
              onBlur={() => void prompt.flush()}
              data-testid="brief-prompt"
            />
            <p className="brief__tip">
              <Lightbulb size={15} aria-hidden />
              <span>
                Name people, moments and what to leave out, for example “Show Lisa being pulled on
                stage, leave out the queues.”
              </span>
            </p>
          </section>
          <aside className="brief__card">
            <h2 className="h2">Length</h2>
            <LengthSettings brief={brief} reel={reel} onChange={(patch) => void setBrief(patch)} />
          </aside>
        </div>
      </div>
      <StepFooter
        tone={needsKey || (!running && (onlyWithoutPreview || !!quotaWarning)) ? 'warning' : 'info'}
        hint={
          needsKey ? (
            <>
              <TriangleAlert size={16} />
              <span>
                {settings?.apiKeyUnreadable
                  ? 'Your saved API key can no longer be read. Reconnect Gemini.'
                  : 'Connect Gemini first. For that you need a free API key.'}
              </span>
              <Button size="sm" variant="ghost" onClick={openSettings}>
                Connect now
              </Button>
            </>
          ) : running ? (
            <>
              <Clock size={16} />
              <span>The analysis is running.</span>
            </>
          ) : onlyWithoutPreview ? (
            <>
              <TriangleAlert size={16} />
              <span>
                {plan.withoutPreview === 1
                  ? 'Your video has no preview, so Gemini can’t watch it.'
                  : 'Your videos have no preview, so Gemini can’t watch them.'}
              </span>
              <Button size="sm" variant="ghost" onClick={() => goToStep('videos')}>
                Go to Videos
              </Button>
            </>
          ) : allFresh ? (
            <>
              <Sparkles size={16} />
              <span>
                {plan.withoutPreview > 0
                  ? 'All videos with a preview are already analysed with this prompt.'
                  : 'All videos are already analysed with this prompt.'}
              </span>
            </>
          ) : (
            <>
              {quotaWarning ? <TriangleAlert size={16} /> : <Clock size={16} />}
              <span>
                {plan.stale > 0
                  ? `New prompt: ${plural(toAnalyse, 'video is', 'videos are')} analysed again`
                  : `Analyse ${plural(toAnalyse, 'video', 'videos')}`}{' '}
                · takes {estimate}
                {cost && ` · ${cost}`}
                {skipped}
                {quotaWarning && ` · ${quotaWarning}`}
              </span>
            </>
          )
        }
      >
        {running ? (
          <Button
            variant="primary"
            iconRight={ArrowRight}
            onClick={() => goToStep('analysis')}
            data-testid="go-analysis"
          >
            Go to Analysis
          </Button>
        ) : allFresh ? (
          <>
            <Button
              icon={RefreshCw}
              loading={starting}
              onClick={() => void start(true)}
              data-testid="start-analysis"
            >
              Analyse again
            </Button>
            <Button
              variant="primary"
              iconRight={ArrowRight}
              onClick={() => goToStep('review')}
              data-testid="next-step"
            >
              Next: Edit
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            icon={Sparkles}
            disabled={videoCount === 0 || onlyWithoutPreview}
            loading={starting}
            onClick={() => void start()}
            data-testid="start-analysis"
          >
            Analyse with Gemini
          </Button>
        )}
      </StepFooter>
    </main>
  )
}
