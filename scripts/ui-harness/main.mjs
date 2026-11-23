// Minimal Electron main process for UI snapshots. No preload, so the renderer falls back to its
// in-memory mock API. The window renders offscreen by default (nothing pops up on the desktop);
// UI_SHOW=1 opens a normal window for manual checks.
//
// env: UI_BUILD_DIR (required), UI_WIDTH, UI_HEIGHT, UI_SCALE, UI_SCENARIO, UI_SHOW

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme } from 'electron'

const buildDir = process.env.UI_BUILD_DIR
const width = Number(process.env.UI_WIDTH || 1440)
const height = Number(process.env.UI_HEIGHT || 900)
const scenario = process.env.UI_SCENARIO || 'home'
const visible = process.env.UI_SHOW === '1'

if (!buildDir) {
  console.error('UI_BUILD_DIR is not set')
  process.exit(1)
}

// a throwaway profile – otherwise Electron writes ~/Library/Application Support/Electron
app.setPath('userData', join(tmpdir(), 'glimpse-ui-harness'))
app.commandLine.appendSwitch('force-device-scale-factor', process.env.UI_SCALE || '1')
if (!visible && app.dock) app.dock.hide()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: visible,
    titleBarStyle: 'hiddenInset',
    // --bg of the current theme (renderer styles/tokens.css)
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#eeeeee',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: !visible,
      backgroundThrottling: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await win.loadFile(join(buildDir, 'index.html'), {
    query: { mock: '1', scenario, snap: '1' }
  })
})

app.on('window-all-closed', () => app.quit())
