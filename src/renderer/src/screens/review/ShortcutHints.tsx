import { Keyboard } from 'lucide-react'

export function ShortcutHints(): React.JSX.Element {
  return (
    <span className="shortcuts">
      <Keyboard size={16} aria-hidden />
      <span>
        <kbd>Space</kbd> Play
      </span>
      <span>
        <kbd>↑</kbd>
        <kbd>↓</kbd> Clip
      </span>
      <span>
        <kbd>I</kbd>
        <kbd>O</kbd> Start/end
      </span>
      <span>
        <kbd>,</kbd>
        <kbd>.</kbd> Start ±0.5 s
      </span>
      <span>
        <kbd>-</kbd>
        <kbd>+</kbd> End ±0.5 s
      </span>
      <span>
        <kbd>X</kbd> Add/remove
      </span>
      <span className="shortcuts__optional">
        <kbd>←</kbd>
        <kbd>→</kbd> 1 s
      </span>
    </span>
  )
}
