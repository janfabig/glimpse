import { useEffect, useRef, useState } from 'react'
import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  ShieldCheck,
  TriangleAlert
} from 'lucide-react'
import { parseIpcError } from '@shared/ipc'
import type { AppInfo, AppSettings, ModelOption } from '@shared/types'
import { api } from '../../api'
import { shortenPath } from '../../lib/format'
import { ffmpegHint } from '../../lib/system'
import {
  closeSettings,
  connectApiKey,
  handleError,
  refreshSettings,
  shell,
  toast,
  updateSettings
} from '../../store/actions'
import { useApp } from '../../store/app-store'
import { Button, IconButton } from '../ui/Button'
import { Modal } from '../ui/Modal'
import './settings.css'

const AI_STUDIO_URL = 'https://aistudio.google.com/apikey'

/** in Settings, the stored key can be pasted right here (main's toast says "in Settings") */
const KEY_UNREADABLE = 'Your saved API key can no longer be read. Paste it again here.'

/** Google rejected the key in use (e.g. deleted or revoked in AI Studio) */
const KEY_REJECTED =
  'Google rejected your API key. It may have been deleted in AI Studio. Paste a new API key here.'

export function SettingsModal(): React.JSX.Element | null {
  const settings = useApp((s) => s.settings)
  const appInfo = useApp((s) => s.appInfo)

  // main's view of the key can change without an event (e.g. the Keychain refused access)
  useEffect(() => {
    void refreshSettings()
  }, [])

  if (!settings) return null
  return (
    <Modal
      title="Settings"
      onClose={closeSettings}
      width={680}
      testId="settings-modal"
      closeTestId="close-settings"
    >
      <div className="settings">
        <GeminiSection settings={settings} />
        <ExportDefaults settings={settings} />
        {appInfo && <SystemInfo info={appInfo} />}
      </div>
    </Modal>
  )
}

function ConnectionPill({ settings }: { settings: AppSettings }): React.JSX.Element {
  // Google rejected it in an analysis or a key test: not "Connected", although a key is there
  if (settings.apiKeyRejected) {
    return (
      <span className="badge badge--warning" data-testid="connection-state">
        <TriangleAlert size={13} /> API key rejected
      </span>
    )
  }
  if (settings.apiKeySource === 'keychain') {
    return (
      <span className="badge badge--success" data-testid="connection-state">
        <CircleCheck size={13} /> Connected
      </span>
    )
  }
  if (settings.apiKeySource === 'env') {
    return (
      <span className="badge" data-testid="connection-state">
        Connected via GEMINI_API_KEY
      </span>
    )
  }
  if (settings.apiKeyUnreadable) {
    return (
      <span className="badge badge--warning" data-testid="connection-state">
        <TriangleAlert size={13} /> API key unreadable
      </span>
    )
  }
  if (settings.fakeAi) {
    return (
      <span className="badge" data-testid="connection-state">
        Test mode
      </span>
    )
  }
  return (
    <span className="badge badge--warning" data-testid="connection-state">
      <TriangleAlert size={13} /> Not connected
    </span>
  )
}

function GeminiSection({ settings }: { settings: AppSettings }): React.JSX.Element {
  const [key, setKey] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [models, setModels] = useState<ModelOption[] | null>(null)
  const connected = settings.hasApiKey || settings.fakeAi
  const stored = settings.apiKeySource === 'keychain' || !!settings.apiKeyUnreadable
  // a key has to be pasted: none, an unreadable one or one Google rejected
  const needsKey = !connected || !!settings.apiKeyRejected
  const keyInput = useRef<HTMLInputElement>(null)

  // Settings often opens before main's fresh answer arrives (an unreadable or rejected key): then
  // the dialog itself still has the focus – move it to the field, so ⌘V lands there
  useEffect(() => {
    if (!needsKey) return
    const active = document.activeElement
    const onDialog =
      active === null || active === document.body || active.getAttribute('role') === 'dialog'
    if (onDialog) keyInput.current?.focus()
  }, [needsKey])

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    api()
      .listModels()
      .then((list) => !cancelled && setModels(list))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connected])

  /** a new key is tested first and only stored when Google accepts it */
  const save = async (): Promise<void> => {
    const value = key.trim()
    if (!value) return
    setBusy('save')
    setResult(null)
    const outcome = await connectApiKey(value)
    if (outcome) {
      setResult({ ok: outcome.ok, message: outcome.message })
      if (outcome.ok) {
        setKey('')
        if (outcome.models) setModels(outcome.models)
      }
    }
    setBusy(null)
  }

  const test = async (): Promise<void> => {
    setBusy('test')
    setResult(null)
    try {
      const outcome = await api().testApiKey(key.trim() || undefined)
      setResult({ ok: outcome.ok, message: outcome.message })
      if (outcome.ok && outcome.models) setModels(outcome.models)
      // main remembers Google's verdict about the key in use ("API key rejected" or not)
      if (outcome.ok || outcome.rejected) void refreshSettings()
    } catch (err) {
      setResult({ ok: false, message: parseIpcError(err).message })
    }
    setBusy(null)
  }

  const removeKey = async (): Promise<void> => {
    if (await updateSettings({ apiKey: null })) {
      setResult(null)
      toast('info', 'The API key was removed from the Keychain.')
    }
  }

  const options = [...(models ?? [])]
  if (!options.some((m) => m.id === settings.model)) {
    options.unshift({ id: settings.model, displayName: settings.model })
  }
  const selectedModel = options.find((m) => m.id === settings.model)

  return (
    <section className="settings__section">
      <div className="settings__section-head">
        <h3 className="settings__title">Gemini</h3>
        <ConnectionPill settings={settings} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="settings-api-key">
          API key
        </label>
        <form
          className="settings__key-row"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="input-affix">
            <input
              id="settings-api-key"
              className="input"
              type={reveal ? 'text' : 'password'}
              placeholder={settings.hasApiKey ? 'Paste a new API key to replace it' : 'AIza…'}
              value={key}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setKey(event.target.value)}
              ref={keyInput}
              data-autofocus={needsKey || undefined}
              data-testid="api-key-input"
            />
            <IconButton
              icon={reveal ? EyeOff : Eye}
              size="sm"
              label={reveal ? 'Hide API key' : 'Show API key'}
              onClick={() => setReveal(!reveal)}
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={!key.trim() || busy === 'test'}
            loading={busy === 'save'}
            data-testid="save-api-key"
          >
            Save
          </Button>
          <Button
            onClick={() => void test()}
            disabled={(!key.trim() && !settings.hasApiKey) || busy === 'save'}
            loading={busy === 'test'}
            data-testid="test-api-key"
          >
            Test
          </Button>
        </form>
        {result ? (
          <p
            className={`field__message field__message--${result.ok ? 'success' : 'error'}`}
            data-testid="api-key-result"
          >
            {result.ok ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
            {result.message}
          </p>
        ) : settings.apiKeyUnreadable ? (
          <p className="field__message field__message--warning" data-testid="api-key-unreadable">
            <TriangleAlert size={15} />
            {KEY_UNREADABLE}
          </p>
        ) : (
          settings.apiKeyRejected && (
            <p className="field__message field__message--warning" data-testid="api-key-rejected">
              <TriangleAlert size={15} />
              {KEY_REJECTED}
            </p>
          )
        )}
        <p className="field__hint">
          {settings.hasApiKey
            ? 'Manage your API keys and billing in '
            : 'No API key yet? Create one for free in '}
          <button
            type="button"
            className="link"
            onClick={() => void shell.openExternal(AI_STUDIO_URL)}
          >
            Google AI Studio <ExternalLink size={12} />
          </button>
          {stored && (
            <>
              {' · '}
              <button
                type="button"
                className="link link--danger"
                onClick={() => void removeKey()}
                data-testid="remove-api-key"
              >
                Remove API key
              </button>
            </>
          )}
        </p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="settings-model">
          Model
        </label>
        <select
          id="settings-model"
          className="select"
          value={settings.model}
          onChange={(event) => void updateSettings({ model: event.target.value })}
          data-testid="model-select"
        >
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
              {model.recommended ? ' (recommended)' : ''}
            </option>
          ))}
        </select>
        {selectedModel?.description && <p className="field__hint">{selectedModel.description}</p>}
      </div>

      <div className="notice" data-testid="privacy-note">
        <ShieldCheck size={16} />
        <span>
          <strong>Privacy:</strong> In the EU, the privacy terms of the paid tier also apply to the
          free quota. But Google asks you not to send personal data to free services, so for footage
          with other people it’s better to use an API key with billing turned on.
        </span>
      </div>
    </section>
  )
}

function ExportDefaults({ settings }: { settings: AppSettings }): React.JSX.Element {
  const change = async (): Promise<void> => {
    try {
      const dir = await api().chooseOutputDir()
      if (dir) await updateSettings({ defaultOutputDir: dir })
    } catch (err) {
      handleError(err)
    }
  }
  return (
    <section className="settings__section">
      <h3 className="settings__title">Export</h3>
      <div className="field">
        <span className="field__label">Default export folder</span>
        <div className="path-row">
          <Folder size={16} aria-hidden />
          <span className="path-row__path" title={settings.defaultOutputDir} data-selectable>
            {shortenPath(settings.defaultOutputDir)}
          </span>
          <Button size="sm" onClick={() => void change()} data-testid="change-default-dir">
            Change
          </Button>
        </div>
        <p className="field__hint">
          Your highlight videos are saved here unless you choose another folder in the project.
        </p>
      </div>
    </section>
  )
}

function SystemInfo({ info }: { info: AppInfo }): React.JSX.Element {
  const { ffmpeg, logFile } = info
  const hint = ffmpegHint(ffmpeg.error)
  // both tools were found but do not start (e.g. after an unfinished brew upgrade)
  const broken = !!ffmpeg.ffmpegPath && !!ffmpeg.ffprobePath
  const hardware = ffmpeg.hardwareEncoders
    .map((name) => (name.startsWith('h264') ? 'H.264' : name))
    .join(', ')
  return (
    <section className="settings__section">
      <h3 className="settings__title">System</h3>
      {!ffmpeg.ok && (
        <div className="notice notice--warning">
          <TriangleAlert size={16} />
          <span>
            {hint.before}
            {hint.command && <code className="code-inline">{hint.command}</code>}
            {hint.after}
          </span>
        </div>
      )}
      <dl className="sysinfo" data-testid="ffmpeg-status" data-ok={ffmpeg.ok}>
        <div>
          <dt>ffmpeg</dt>
          <dd>
            {ffmpeg.ok ? (
              <span className="sysinfo__ok">
                <CircleCheck size={14} /> Version {ffmpeg.version}
              </span>
            ) : (
              <span className="sysinfo__bad">{broken ? 'Does not start' : 'Not found'}</span>
            )}
          </dd>
        </div>
        {ffmpeg.ffmpegPath && (
          <div>
            <dt>Path</dt>
            <dd className="sysinfo__mono" data-selectable>
              {ffmpeg.ffmpegPath}
            </dd>
          </div>
        )}
        {ffmpeg.ok && (
          <div>
            <dt>Hardware encoder</dt>
            <dd>
              {hardware ? `VideoToolbox (${hardware})` : 'Not available: previews use the CPU'}
            </dd>
          </div>
        )}
        <div>
          <dt>App version</dt>
          <dd>{info.version}</dd>
        </div>
        <div>
          <dt>Data folder</dt>
          <dd className="sysinfo__mono" title={info.userDataDir} data-selectable>
            {shortenPath(info.userDataDir)}
          </dd>
        </div>
        {logFile && (
          <div>
            <dt>Log file</dt>
            <dd>
              <Button
                size="sm"
                icon={FolderOpen}
                title={shortenPath(logFile)}
                onClick={() => void shell.showInFinder(logFile)}
                data-testid="show-log-file"
              >
                Show log file in Finder
              </Button>
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}
