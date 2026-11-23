import { useState } from 'react'
import { ChevronLeft, Pencil } from 'lucide-react'
import type { Project } from '@shared/types'
import { IconButton } from '../../components/ui/Button'
import { goHome, mutate } from '../../store/actions'

/** back to the overview + the project name, renamable in place */
export function ProjectTitle({ project }: { project: Project }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (): void => {
    const name = draft?.trim()
    setDraft(null)
    if (name && name !== project.name) void mutate({ type: 'rename', name })
  }

  return (
    <div className="project-title">
      <IconButton icon={ChevronLeft} label="Back to home" onClick={goHome} data-testid="go-home" />
      {draft === null ? (
        <button
          type="button"
          className="project-title__name"
          title="Rename project"
          onClick={() => setDraft(project.name)}
          data-testid="project-name"
        >
          <span>{project.name}</span>
          <Pencil size={13} aria-hidden />
        </button>
      ) : (
        <input
          className="input project-title__input"
          value={draft}
          maxLength={80}
          autoFocus
          aria-label="Project name"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') {
              event.stopPropagation()
              setDraft(null)
            }
          }}
        />
      )}
    </div>
  )
}
