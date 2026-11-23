import type { ButtonHTMLAttributes } from 'react'
import { LoaderCircle, type LucideIcon } from 'lucide-react'
import { cx } from '../../lib/dom'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: LucideIcon
  iconRight?: LucideIcon
  loading?: boolean
}

const ICON_SIZE = { sm: 14, md: 16, lg: 18 }

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  const iconSize = ICON_SIZE[size]
  return (
    <button
      type={type}
      className={cx('btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <LoaderCircle size={iconSize} className="spin" aria-hidden />
      ) : (
        Icon && <Icon size={iconSize} strokeWidth={2.2} aria-hidden />
      )}
      {children}
      {IconRight && !loading && <IconRight size={iconSize} strokeWidth={2.2} aria-hidden />}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  /** accessible name, also shown as tooltip */
  label: string
  size?: 'sm' | 'md'
  variant?: 'plain' | 'accent' | 'danger'
}

export function IconButton({
  icon: Icon,
  label,
  size = 'md',
  variant = 'plain',
  className,
  type = 'button',
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={cx(
        'icon-btn',
        size === 'sm' && 'icon-btn--sm',
        variant !== 'plain' && `icon-btn--${variant}`,
        className
      )}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon size={size === 'sm' ? 15 : 17} strokeWidth={2.1} aria-hidden />
    </button>
  )
}
