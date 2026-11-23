import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { trapTab } from '../../lib/focus-trap'
import { Button, IconButton } from './Button'

/** open modals, innermost last – only the innermost one reacts to Escape and Tab */
const modalStack: object[] = []

/**
 * Modal dialog. Focus starts on the control marked `data-autofocus` (else on the dialog itself) and
 * Tab / Shift+Tab cycle through the dialog's controls only.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width,
  testId,
  closeTestId
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  testId?: string
  closeTestId?: string
}): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    const token = {}
    modalStack.push(token)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const initial = dialog?.querySelector<HTMLElement>('[data-autofocus]')
    ;(initial ?? dialog)?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (modalStack[modalStack.length - 1] !== token) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
      } else if (event.key === 'Tab' && dialog && trapTab(dialog, event.shiftKey)) {
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      modalStack.splice(modalStack.indexOf(token), 1)
      previous?.focus()
    }
  }, [])

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
        data-testid={testId}
      >
        <header className="modal__head">
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
          <IconButton icon={X} label="Close" onClick={onClose} data-testid={closeTestId} />
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>,
    document.body
  )
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel
}: {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width={460}
      testId="confirm-dialog"
      footer={
        <>
          {/* Enter confirms right away – but never a destructive action */}
          <Button variant="ghost" onClick={onCancel} data-autofocus={danger || undefined}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            data-autofocus={!danger || undefined}
            data-testid="confirm-ok"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="confirm__text">{message}</p>
    </Modal>
  )
}
