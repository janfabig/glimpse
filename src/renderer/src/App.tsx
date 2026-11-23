import { useEffect } from 'react'
import { CircleAlert } from 'lucide-react'
import { AppMark } from './components/AppMark'
import { usePreventFileNavigation } from './components/use-file-drop'
import { SettingsModal } from './components/settings/SettingsModal'
import { Toasts } from './components/Toasts'
import { ConfirmDialog } from './components/ui/Modal'
import { HomeScreen } from './screens/home/HomeScreen'
import { ProjectScreen } from './screens/project/ProjectScreen'
import { answerConfirm, bootstrap } from './store/actions'
import { useApp } from './store/app-store'

function App(): React.JSX.Element {
  const phase = useApp((s) => s.phase)
  const bootError = useApp((s) => s.bootError)
  const view = useApp((s) => s.view)
  const settingsOpen = useApp((s) => s.settingsOpen)
  const confirm = useApp((s) => s.confirm)
  usePreventFileNavigation()

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    if (phase === 'ready') document.body.dataset.ready = 'true'
  }, [phase])

  return (
    <div className="app">
      {phase === 'loading' && (
        <div className="boot" aria-busy>
          <AppMark size={48} />
        </div>
      )}
      {phase === 'error' && (
        <div className="boot">
          <div className="boot__inner">
            <CircleAlert size={32} color="var(--danger)" />
            <h1 className="h2">Glimpse could not start</h1>
            <p className="muted">{bootError}</p>
          </div>
        </div>
      )}
      {phase === 'ready' &&
        (view.name === 'home' ? <HomeScreen /> : <ProjectScreen step={view.step} />)}
      {phase === 'ready' && settingsOpen && <SettingsModal />}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={() => answerConfirm(true)}
          onCancel={() => answerConfirm(false)}
        />
      )}
      <Toasts />
    </div>
  )
}

export default App
