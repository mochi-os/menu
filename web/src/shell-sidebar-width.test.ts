// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'

// public/shell.js runs in the top-level shell window, outside the React tree
// and outside the bundler, so it is loaded as source and evaluated against a
// jsdom document shaped like the shell page, the same harness the other
// shell-*.test.ts files use.
const SHELL = readFileSync(resolve(__dirname, '../public/shell.js'), 'utf8')

function boot() {
  document.body.innerHTML =
    '<div id="app-container"></div><div id="menu"></div><div id="shell-progress"></div>'
  window.history.replaceState({}, '', '/feeds/')

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (String(url).indexOf('/_/token') >= 0) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ app: 'feeds-entity', token: 'token' }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: {} }),
      })
    })
  )

  new Function(SHELL)()

  const iframe = document.getElementById('app-frame') as HTMLIFrameElement
  if (!iframe) throw new Error('shell did not create its app iframe')

  const posted: Record<string, unknown>[] = []
  const source = iframe.contentWindow as Window
  source.postMessage = ((msg: Record<string, unknown>) => {
    posted.push(msg)
  }) as typeof source.postMessage

  const send = (data: Record<string, unknown>) => {
    const event = new MessageEvent('message', { data })
    Object.defineProperty(event, 'source', { value: source })
    window.dispatchEvent(event)
  }

  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  // The width the shell hands the next app it loads.
  const initWidth = async () => {
    send({ type: 'ready' })
    await settle()
    const init = posted.find((m) => m.type === 'init')
    if (!init) throw new Error('shell sent no init')
    return init.sidebarWidth
  }

  return { send, settle, initWidth }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('shell sidebar width', () => {
  it('hands an app no width when none was ever dragged', async () => {
    expect(await boot().initWidth()).toBeNull()
  })

  it('hands every app the width saved by any of them', async () => {
    localStorage.setItem('sidebar_width', '320')
    expect(await boot().initWidth()).toBe(320)
  })

  it('saves the width an app reports, for the next app it loads', async () => {
    const shell = boot()
    shell.send({ type: 'sidebar-width', width: 300.4 })
    await shell.settle()
    expect(localStorage.getItem('sidebar_width')).toBe('300')
    expect(await boot().initWidth()).toBe(300)
  })

  it('forgets the width when an app goes back to the default', async () => {
    localStorage.setItem('sidebar_width', '320')
    const shell = boot()
    shell.send({ type: 'sidebar-width', width: null })
    await shell.settle()
    expect(localStorage.getItem('sidebar_width')).toBeNull()
    expect(await boot().initWidth()).toBeNull()
  })

  it('keeps the saved width when an app sends something that is not one', async () => {
    localStorage.setItem('sidebar_width', '320')
    const shell = boot()
    for (const width of [undefined, 'wide', 50, 1e9, Number.NaN, {}, true]) {
      shell.send({ type: 'sidebar-width', width })
    }
    await shell.settle()
    expect(localStorage.getItem('sidebar_width')).toBe('320')
  })

  it('ignores a stored value that is not a width', async () => {
    localStorage.setItem('sidebar_width', 'wide')
    expect(await boot().initWidth()).toBeNull()
  })
})
