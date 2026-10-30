// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { TooltipProvider } from '@mochi/web'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MenuShortcuts } from './menu-apps'
import { followInPlace } from './navigate'
import type { useMenuApps } from './use-menu-apps'

i18n.loadAndActivate({ locale: 'en', messages: {} })

// The menu's own links used to be plain anchors, so each click reloaded the
// whole shell page; a plain left click now asks the shell (public/shell.js,
// same window) to load the app in its frame.
const query = {
  data: {
    icons: [
      { id: 'home', path: '', name: 'Home', file: 'images/home.svg', link: '' },
      {
        id: 'settings',
        path: 'settings',
        name: 'Settings',
        file: 'images/settings.svg',
        link: 'settings',
      },
    ],
  },
} as unknown as ReturnType<typeof useMenuApps>

function shortcuts() {
  render(
    <I18nProvider i18n={i18n}>
      <TooltipProvider>
        <MenuShortcuts query={query} current='feeds' recent={['settings']} />
      </TooltipProvider>
    </I18nProvider>
  )
  return screen.getByRole('link', { name: 'Settings' })
}

const listeners: EventListener[] = []
afterEach(() => {
  for (const listener of listeners.splice(0))
    window.removeEventListener('mochi-navigate', listener)
})

// What the shell does with the event: take a link to an app, or not.
function shellTakes(take: boolean) {
  const asked: string[] = []
  const listener = (event: Event) => {
    asked.push((event as CustomEvent<{ url: string }>).detail.url)
    if (take) event.preventDefault()
  }
  window.addEventListener('mochi-navigate', listener)
  listeners.push(listener)
  return asked
}

describe('menu shortcuts: an app loads in place', () => {
  it('asks the shell on a plain click, and keeps the page when it takes it', () => {
    const asked = shellTakes(true)
    const link = shortcuts()
    // fireEvent returns false when the default was prevented.
    expect(fireEvent.click(link)).toBe(false)
    expect(asked).toEqual(['/settings/'])
  })

  it('follows the link when the shell does not take it', () => {
    const asked = shellTakes(false)
    const link = shortcuts()
    expect(fireEvent.click(link)).toBe(true)
    expect(asked).toEqual(['/settings/'])
  })

  it('leaves a modified click to the browser: a new tab or window', () => {
    const asked = shellTakes(true)
    const link = shortcuts()
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
      expect(fireEvent.click(link, { [modifier]: true })).toBe(true)
    }
    expect(fireEvent.click(link, { button: 1 })).toBe(true)
    expect(asked).toEqual([])
  })

  it('keeps the address for a new tab', () => {
    shellTakes(true)
    expect(shortcuts().getAttribute('href')).toBe('/settings/')
  })
})

// Notification clicks take the same way: they called the app-side helper,
// which in the shell's own window is a plain page load.
describe('menu notifications: a link loads in place', () => {
  it('asks the shell, and does not load the page when it takes it', () => {
    const asked = shellTakes(true)
    const assign = vi.fn()
    vi.stubGlobal('location', {
      ...window.location,
      set href(url: string) {
        assign(url)
      },
    })
    followInPlace('/feeds/abc')
    expect(asked).toEqual(['/feeds/abc'])
    expect(assign).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('loads the page when the shell does not take it', () => {
    shellTakes(false)
    const assign = vi.fn()
    vi.stubGlobal('location', {
      ...window.location,
      set href(url: string) {
        assign(url)
      },
    })
    followInPlace('/feeds/abc')
    expect(assign).toHaveBeenCalledWith('/feeds/abc')
    vi.unstubAllGlobals()
  })
})
