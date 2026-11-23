// The macOS application menu: our labels on Electron's role items, so the native behaviour
// (shortcuts, Services, window list) stays. The Edit menu is what makes ⌘C/⌘V work in text fields.
// Reload and the developer tools exist in development only.

import type { MenuItemConstructorOptions } from 'electron'

export function applicationMenuTemplate(options: {
  appName: string
  isPackaged: boolean
}): MenuItemConstructorOptions[] {
  const { appName } = options
  const development: MenuItemConstructorOptions[] = options.isPackaged
    ? []
    : [
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force Reload' },
        { role: 'toggleDevTools', label: 'Toggle Developer Tools' },
        { type: 'separator' }
      ]
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `About ${appName}` },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${appName}` },
        { role: 'hideOthers', label: 'Hide Others' },
        { role: 'unhide', label: 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${appName}` }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' }
      ]
    },
    {
      label: 'View',
      submenu: [...development, { role: 'togglefullscreen', label: 'Toggle Full Screen' }]
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize', label: 'Minimize' },
        { role: 'zoom', label: 'Zoom' },
        { type: 'separator' },
        { role: 'close', label: 'Close Window' },
        { type: 'separator' },
        { role: 'front', label: 'Bring All to Front' }
      ]
    }
  ]
}
