import { useState } from 'react'
import { Copy, RefreshCw, Terminal } from 'lucide-react'
import type { FfmpegStatus } from '@shared/types'
import { Button, IconButton } from '../../components/ui/Button'
import { ffmpegBlocker } from '../../lib/system'
import { refreshAppInfo, toast } from '../../store/actions'

/**
 * Blocking hint: without a working ffmpeg nothing can be imported or cut. The packaged app carries
 * its own ffmpeg, so there it means a damaged app; a development build gets the command that
 * fetches ffmpeg (lib/system.ts).
 */
export function FfmpegMissing({ status }: { status: FfmpegStatus }): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const blocker = ffmpegBlocker(status)
  const { command } = blocker

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      toast('success', 'Command copied. Paste it into Terminal.')
    } catch {
      toast('warning', 'Copying didn’t work. Select the command by hand.')
    }
  }

  const recheck = async (): Promise<void> => {
    setChecking(true)
    const info = await refreshAppInfo()
    setChecking(false)
    if (!info) return
    if (info.ffmpeg.ok) toast('success', 'ffmpeg is ready. You can get started.')
    else toast('warning', info.ffmpeg.error ?? 'ffmpeg was not found yet.')
  }

  return (
    <section className="blocker" data-testid="ffmpeg-missing" data-broken={blocker.broken}>
      <span className="blocker__icon" aria-hidden>
        <Terminal size={28} strokeWidth={2} />
      </span>
      <h1 className="h2">{blocker.title}</h1>
      <p className="blocker__text">{blocker.text}</p>
      {command && (
        <div className="codeblock">
          <code data-selectable>{command}</code>
          <IconButton icon={Copy} label="Copy command" onClick={() => void copy(command)} />
        </div>
      )}
      <p className="blocker__hint">{blocker.hint}</p>
      <Button variant="primary" icon={RefreshCw} loading={checking} onClick={() => void recheck()}>
        Check again
      </Button>
    </section>
  )
}
