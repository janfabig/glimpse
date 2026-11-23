import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { applicationMenuTemplate } from './menu'

const items = (menu: MenuItemConstructorOptions): MenuItemConstructorOptions[] =>
  (menu.submenu as MenuItemConstructorOptions[]).filter((item) => item.type !== 'separator')

const describeMenu = (menu: MenuItemConstructorOptions[]): string[][] =>
  menu.map((top) => [
    String(top.label),
    ...items(top).map((item) => `${String(item.role)}: ${String(item.label)}`)
  ])

describe('applicationMenuTemplate', () => {
  it('is English and built from role items (⌘C/⌘V in text fields need the Edit menu)', () => {
    const menu = applicationMenuTemplate({ appName: 'Glimpse', isPackaged: true })
    expect(describeMenu(menu)).toEqual([
      [
        'Glimpse',
        'about: About Glimpse',
        'services: Services',
        'hide: Hide Glimpse',
        'hideOthers: Hide Others',
        'unhide: Show All',
        'quit: Quit Glimpse'
      ],
      [
        'Edit',
        'undo: Undo',
        'redo: Redo',
        'cut: Cut',
        'copy: Copy',
        'paste: Paste',
        'selectAll: Select All'
      ],
      ['View', 'togglefullscreen: Toggle Full Screen'],
      [
        'Window',
        'minimize: Minimize',
        'zoom: Zoom',
        'close: Close Window',
        'front: Bring All to Front'
      ]
    ])
    expect(menu[3].role).toBe('window')
  })

  it('offers reload and the developer tools only in development', () => {
    const roles = (isPackaged: boolean): string[] =>
      applicationMenuTemplate({ appName: 'Glimpse', isPackaged })
        .flatMap(items)
        .map((item) => String(item.role))
    for (const role of ['reload', 'forceReload', 'toggleDevTools']) {
      expect(roles(true)).not.toContain(role)
      expect(roles(false)).toContain(role)
    }
  })
})
