import { useState } from 'react'
import { Film, Trash2 } from 'lucide-react'
import { formatDurationDe } from '@shared/time'
import type { ProjectSummary } from '@shared/types'
import { IconButton } from '../../components/ui/Button'
import { ConfirmDialog } from '../../components/ui/Modal'
import { formatRelative, plural } from '../../lib/format'
import { imageSrc } from '../../lib/media'
import { deleteProject, openProject } from '../../store/actions'

function statusBadge(project: ProjectSummary): { label: string; tone: string } {
  if (project.lastExportPath) return { label: 'Exported', tone: 'badge--success' }
  if (project.selectedCount > 0) {
    return { label: `${plural(project.selectedCount, 'clip', 'clips')} selected`, tone: '' }
  }
  if (project.videoCount > 0) return { label: 'Ready for your prompt', tone: 'badge--neutral' }
  return { label: 'Empty', tone: 'badge--neutral' }
}

export function ProjectCard({ project }: { project: ProjectSummary }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const poster = imageSrc(project.posterPath)
  const badge = statusBadge(project)

  return (
    <article className="project-card" data-testid="project-card" data-project-id={project.id}>
      <button
        type="button"
        className="project-card__open"
        onClick={() => void openProject(project.id)}
        aria-label={`Open ${project.name}`}
      >
        <span className="project-card__cover">
          {poster ? (
            <>
              <img className="project-card__backdrop" src={poster} alt="" draggable={false} />
              <img className="project-card__poster" src={poster} alt="" draggable={false} />
            </>
          ) : (
            <span className="project-card__empty">
              <Film size={28} strokeWidth={1.8} />
            </span>
          )}
          <span className={`badge badge--solid project-card__badge ${badge.tone}`}>
            {badge.label}
          </span>
        </span>
        <span className="project-card__body">
          <span className="project-card__name">{project.name}</span>
          <span className="project-card__meta">
            {project.videoCount > 0
              ? `${plural(project.videoCount, 'video', 'videos')} · ${formatDurationDe(project.totalDurationSec)}`
              : 'No videos yet'}
          </span>
          <span className="project-card__date">Edited {formatRelative(project.updatedAt)}</span>
        </span>
      </button>
      <IconButton
        className="project-card__delete"
        icon={Trash2}
        size="sm"
        variant="danger"
        label="Delete project"
        onClick={() => setConfirming(true)}
        data-testid="delete-project"
      />
      {confirming && (
        <ConfirmDialog
          title={`Delete “${project.name}”?`}
          message="This project’s selection, edits and analysis are deleted. Your original videos and the highlight videos you already exported are kept."
          confirmLabel="Delete project"
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            void deleteProject(project.id, project.name)
          }}
        />
      )}
    </article>
  )
}
