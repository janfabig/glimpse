import { CloudUpload, Plus } from 'lucide-react'
import { AppMark } from '../../components/AppMark'
import { DropOverlay } from '../../components/FileDrop'
import { useFileDrop } from '../../components/use-file-drop'
import { TopBar } from '../../components/TopBar'
import { Button } from '../../components/ui/Button'
import { createProject } from '../../store/actions'
import { useApp } from '../../store/app-store'
import { FfmpegMissing } from './FfmpegMissing'
import { HowItWorks } from './HowItWorks'
import { OnboardingCard } from './OnboardingCard'
import { ProjectCard } from './ProjectCard'
import './home.css'

export function HomeScreen(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const appInfo = useApp((s) => s.appInfo)
  const projects = useApp((s) => s.projects)
  const creating = useApp((s) => !!s.busy.createProject)
  const ffmpegMissing = !!appInfo && !appInfo.ffmpeg.ok
  const needsKey = !!settings && !settings.hasApiKey && !settings.fakeAi
  const dragging = useFileDrop((paths) => void createProject(paths), !ffmpegMissing)

  return (
    <div className="screen" data-screen="home">
      <TopBar
        left={
          <span className="app-title">
            <AppMark size={22} /> Glimpse
          </span>
        }
      />
      <main className="home">
        <div className="home__inner">
          {appInfo && ffmpegMissing ? (
            <FfmpegMissing status={appInfo.ffmpeg} />
          ) : (
            <>
              <section className="home__hero">
                <div className="home__hero-text">
                  <h1 className="home__title">
                    {projects.length > 0 ? 'Your highlight videos' : 'Welcome to Glimpse'}
                  </h1>
                  <p className="home__lead">
                    Add the videos from your Meta glasses, tell Gemini what matters, and get a fully
                    edited highlight video in a few minutes.
                  </p>
                </div>
                <Button
                  variant={needsKey ? 'secondary' : 'primary'}
                  size="lg"
                  icon={Plus}
                  loading={creating}
                  onClick={() => void createProject()}
                  data-testid="new-project"
                >
                  New highlight video
                </Button>
              </section>

              {needsKey && <OnboardingCard />}

              {projects.length > 0 ? (
                <section className="home__section">
                  <h2 className="h2">Recently edited</h2>
                  <div className="home__grid">
                    {projects.map((project) => (
                      <ProjectCard key={project.id} project={project} />
                    ))}
                  </div>
                </section>
              ) : (
                <HowItWorks />
              )}

              <p className="home__tip">
                <CloudUpload size={16} aria-hidden />
                Tip: Drag videos straight from Finder into this window to start a new highlight
                video right away.
              </p>
            </>
          )}
        </div>
      </main>
      {dragging && (
        <DropOverlay
          title="Start a new highlight video"
          text="Drop the videos to create a project with them right away."
        />
      )}
    </div>
  )
}
