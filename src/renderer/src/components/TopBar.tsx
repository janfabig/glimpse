import type { ReactNode } from 'react'
import { Settings } from 'lucide-react'
import { openSettings } from '../store/actions'
import { IconButton } from './ui/Button'

/** Window top bar: drag region next to the traffic lights; interactive children are no-drag. */
export function TopBar({
  left,
  center,
  right
}: {
  left?: ReactNode
  center?: ReactNode
  right?: ReactNode
}): React.JSX.Element {
  return (
    <header className="topbar">
      <div className="topbar__left">{left}</div>
      <div className="topbar__center">{center}</div>
      <div className="topbar__right">
        {right}
        <IconButton
          icon={Settings}
          label="Settings"
          onClick={openSettings}
          data-testid="open-settings"
        />
      </div>
    </header>
  )
}
