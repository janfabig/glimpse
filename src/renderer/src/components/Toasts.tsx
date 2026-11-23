import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import type { ToastEvent } from '@shared/types'
import { useApp } from '../store/app-store'
import { dismissToast } from '../store/actions'
import { Button, IconButton } from './ui/Button'

const ICONS: Record<ToastEvent['level'], LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert
}

export function Toasts(): React.JSX.Element {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.level]
        return (
          <div
            key={toast.id}
            className={`toast toast--${toast.level}`}
            role={toast.level === 'error' ? 'alert' : 'status'}
            data-testid="toast"
            data-level={toast.level}
          >
            <Icon className="toast__icon" size={18} strokeWidth={2.2} aria-hidden />
            <div className="toast__body">
              <span>{toast.message}</span>
              {toast.action && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    toast.action?.run()
                    dismissToast(toast.id)
                  }}
                >
                  {toast.action.label}
                </Button>
              )}
            </div>
            <IconButton icon={X} size="sm" label="Dismiss" onClick={() => dismissToast(toast.id)} />
          </div>
        )
      })}
    </div>
  )
}
