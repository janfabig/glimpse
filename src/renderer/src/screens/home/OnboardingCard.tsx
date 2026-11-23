import { useState } from 'react'
import { CircleAlert, ExternalLink, Lock, ShieldCheck, Sparkles } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { connectApiKey, shell, toast } from '../../store/actions'
import { useApp } from '../../store/app-store'

/** First run without an API key: connect Gemini in two steps, right on the start screen. */
export function OnboardingCard(): React.JSX.Element {
  const unreadable = useApp((s) => !!s.settings?.apiKeyUnreadable)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** the key is tested first and only stored when Google accepts it */
  const connect = async (): Promise<void> => {
    const value = key.trim()
    if (!value) return
    setBusy(true)
    setError(null)
    const result = await connectApiKey(value)
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      setError(result.message)
      return
    }
    toast('success', 'Gemini is connected. You can get started.')
  }

  return (
    <section className="onboarding" data-testid="onboarding">
      <div className="onboarding__icon" aria-hidden>
        <Sparkles size={26} strokeWidth={2} />
      </div>
      <div className="onboarding__content">
        <p className="eyebrow">
          {unreadable ? 'Set up again · about 1 minute' : 'One-time setup · about 2 minutes'}
        </p>
        <h2 className="h2">{unreadable ? 'Reconnect Gemini' : 'Connect Gemini'}</h2>
        <p className="onboarding__text" data-testid="onboarding-text">
          {unreadable
            ? 'Your saved API key can no longer be read. Paste it again here.'
            : 'Gemini watches your videos and finds the best moments. For that you need a free API key from Google.'}
        </p>
        <ol className="onboarding__steps">
          <li>
            <span className="onboarding__num">1</span>
            <div className="onboarding__step-text">
              <strong>{unreadable ? 'Copy your API key' : 'Create an API key'}</strong>
              <span>
                {unreadable
                  ? 'Open Google AI Studio and copy your API key again.'
                  : 'Open Google AI Studio, click “Create API key” and copy it.'}
              </span>
            </div>
            <Button
              size="sm"
              iconRight={ExternalLink}
              onClick={() => void shell.openExternal('https://aistudio.google.com/apikey')}
            >
              Open AI Studio
            </Button>
          </li>
          <li>
            <span className="onboarding__num">2</span>
            <div className="onboarding__step-text">
              <strong>Paste your API key here</strong>
              <form
                className="onboarding__form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void connect()
                }}
              >
                <input
                  className="input"
                  type="password"
                  placeholder="AIza…"
                  value={key}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setKey(event.target.value)}
                  aria-label="Gemini API key"
                  data-testid="onboarding-key-input"
                />
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy}
                  disabled={!key.trim()}
                  data-testid="onboarding-connect"
                >
                  Connect
                </Button>
              </form>
              {error && (
                <p className="field__message field__message--error" data-testid="onboarding-error">
                  <CircleAlert size={15} /> {error}
                </p>
              )}
            </div>
          </li>
        </ol>
        <p className="onboarding__note" data-testid="onboarding-privacy">
          <ShieldCheck size={13} aria-hidden /> For the analysis, a 720p copy of each video goes to
          Google and is deleted there after 48 hours at most. Only about 20 analyses a day are free.
          For big festivals, billing is worth it (a few cents per video).
        </p>
        <p className="onboarding__note">
          <Lock size={13} aria-hidden /> Your API key is stored encrypted in the macOS Keychain and
          is only sent to Google.
        </p>
      </div>
    </section>
  )
}
