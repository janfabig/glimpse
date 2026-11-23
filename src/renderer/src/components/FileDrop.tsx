import { CloudUpload } from 'lucide-react'

export function DropOverlay({ title, text }: { title: string; text: string }): React.JSX.Element {
  return (
    <div className="drop-overlay" aria-hidden>
      <div className="drop-overlay__box">
        <span className="drop-overlay__icon">
          <CloudUpload size={34} strokeWidth={2} />
        </span>
        <p className="h2">{title}</p>
        <p className="muted">{text}</p>
      </div>
    </div>
  )
}
