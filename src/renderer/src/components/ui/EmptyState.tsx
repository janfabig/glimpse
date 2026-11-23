import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export function EmptyState({
  icon: Icon,
  title,
  children,
  actions
}: {
  icon: LucideIcon
  title: string
  children?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon size={26} strokeWidth={1.9} />
      </span>
      <p className="empty__title">{title}</p>
      {children && <p className="empty__text">{children}</p>}
      {actions && <div className="empty__actions">{actions}</div>}
    </div>
  )
}
