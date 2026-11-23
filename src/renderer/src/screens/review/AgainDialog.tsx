import { useState } from 'react'
import { CircleAlert, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'
import type { Project } from '@shared/types'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { againBlocker, againDialog } from '../../lib/again'
import { analyzeAgain } from '../../store/actions'
import { useApp } from '../../store/app-store'
import './again.css'

/**
 * "Ask Gemini again" (docs/ARCHITECTURE.md §5 Jobs, "Second pass"): the button for the header of
 * the Edit step and its dialog. The Edit step owns `open`, so its shortcuts rest while the dialog
 * is up.
 */
export function AgainButton({
  project,
  open,
  onOpenChange
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const blocker = againBlocker(project, settings)
  return (
    <>
      <Button
        icon={RefreshCw}
        onClick={() => onOpenChange(true)}
        disabled={blocker !== null}
        title={blocker ?? 'Tell Gemini what to do differently. It looks at all your videos again.'}
        data-testid="again-open"
      >
        Ask Gemini again
      </Button>
      {open && <AgainDialog project={project} onClose={() => onOpenChange(false)} />}
    </>
  )
}

function AgainDialog({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const starting = useApp((s) => !!s.busy.startAnalysis)
  const [wish, setWish] = useState('')
  const dialog = againDialog(project, settings, wish)
  return (
    <Modal
      title="Ask Gemini again"
      onClose={onClose}
      width={540}
      testId="again-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {/* on success the analysis step opens and the Edit step (with this dialog) leaves */}
          <Button
            variant="primary"
            icon={Sparkles}
            disabled={!dialog.canStart}
            loading={starting}
            onClick={() => void analyzeAgain(wish)}
            data-testid="again-start"
          >
            Analyse again
          </Button>
        </>
      }
    >
      <div className="again">
        <p className="confirm__text">{dialog.intro}</p>
        <label className="field">
          <span className="field__label">What should Gemini do differently?</span>
          {/* Enter makes a new line: there is no form to submit */}
          <textarea
            className="textarea"
            rows={4}
            value={wish}
            placeholder="For example “More moments with my friends, less stage.”"
            onChange={(event) => setWish(event.target.value)}
            data-autofocus
            data-testid="again-wish"
          />
        </label>
        {dialog.tooLong && (
          <p className="field__message field__message--error" data-testid="again-too-long">
            <CircleAlert size={15} />
            {dialog.tooLong}
          </p>
        )}
        <p className="confirm__text">{dialog.consequence}</p>
        {dialog.quotaWarning && (
          <p className="field__message field__message--warning" data-testid="again-quota">
            <TriangleAlert size={15} />
            {dialog.quotaWarning}
          </p>
        )}
      </div>
    </Modal>
  )
}
