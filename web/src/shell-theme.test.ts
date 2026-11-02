// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'

// public/shell.js runs in the top-level shell window, outside the React tree
// and outside the bundler, so it is loaded as source and evaluated against a
// jsdom document shaped like the shell page — the same harness the other
// shell-*.test.ts files use.
const SHELL = readFileSync(resolve(__dirname, '../public/shell.js'), 'utf8')

// jsdom implements no matchMedia, so the harness supplies one whose value the
// test can move — standing in for the OS switching to dark while the tab is
// open, which is the whole point of the "auto" preference.
function stubColorScheme(dark: boolean) {
  const listeners: (() => void)[] = []
  const query = {
    matches: dark,
    addEventListener: (_event: string, handler: () => void) =>
      listeners.push(handler),
    removeEventListener: () => {},
  }
  vi.stubGlobal('matchMedia', (text: string) => {
    if (!String(text).includes('prefers-color-scheme'))
      throw new Error('unexpected query: ' + text)
    return query
  })
  return {
    set: (next: boolean) => {
      query.matches = next
      listeners.forEach((l) => l())
    },
  }
}

const appearance = () =>
  document.documentElement.classList.contains('dark')
    ? 'dark'
    : document.documentElement.classList.contains('light')
      ? 'light'
      : 'none'

// The root's theme values must come from the server, never from the app that
// reports a change: the consent dialog renders from them.
function boot(
  options: {
    theme?: string
    appearance?: string
    root?: string
    identity?: Record<string, unknown>
    minted?: Record<string, unknown>
  } = {}
) {
  document.documentElement.removeAttribute('style')
  // The server renders the user's theme inline on the shell page before any
  // script runs; `root` stands in for that.
  if (options.root) document.documentElement.style.cssText = options.root
  document.body.innerHTML =
    '<div id="app-container"></div><div id="menu"></div><div id="shell-progress"></div>'
  window.history.replaceState({}, '', '/feeds/')

  // Every /_/shell call the shell made — the witness for "did it re-read the
  // theme from the server rather than trusting the message?"
  let shellCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (String(url).indexOf('/_/shell') >= 0) {
        shellCalls++
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              menuToken: 'menu-token',
              theme: options.theme ?? '',
              appearance: options.appearance ?? 'auto',
              ...(options.identity ? { identity: options.identity } : {}),
            }),
        })
      }
      if (String(url).indexOf('/_/token') >= 0) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              app: 'feeds-entity',
              token: 'app-token',
              ...(options.minted ? { identity: options.minted } : {}),
            }),
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

  // The shell only listens to its own iframe, so the event must claim to come
  // from there — which is exactly what a hostile app in that iframe can do.
  const send = (data: Record<string, unknown>) => {
    const event = new MessageEvent('message', { data })
    Object.defineProperty(event, 'source', { value: source })
    window.dispatchEvent(event)
  }

  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  const property = (name: string) =>
    document.documentElement.style.getPropertyValue(name)

  return { send, settle, posted, property, shellCalls: () => shellCalls }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('style')
  document.documentElement.classList.remove('light', 'dark')
  window.history.replaceState({}, '', '/')
})

// The values an attack needs: make the text the same colour as what's behind
// it, and the dialog guarding a permission grant is invisible while its Allow
// button stays exactly where the app knows it will be.
const HOSTILE = {
  hue: '250',
  chroma: '0.1',
  background: '250',
  overrides: {
    '--background': 'rgb(17, 17, 17)',
    '--foreground': 'rgb(17, 17, 17)',
    '--border': 'transparent',
    'font-size': '150%',
  },
}

describe('shell theme: the trusted root takes no values from an app', () => {
  it('installs nothing an app sent, even when the server has no theme', async () => {
    const shell = boot({ theme: '' })
    shell.send({ type: 'color-theme-set', colorTheme: HOSTILE })
    await shell.settle()

    // Before this was server-owned, every one of these landed on <html> and
    // the consent dialog inherited them.
    expect(shell.property('--background')).toBe('')
    expect(shell.property('--foreground')).toBe('')
    expect(shell.property('--border')).toBe('')
    expect(shell.property('--hue')).toBe('')
    expect(shell.property('font-size')).toBe('')
  })

  it('installs the server-resolved theme instead', async () => {
    const shell = boot({ theme: '--hue: 140; --foreground: oklch(0.145 0 0)' })
    shell.send({ type: 'color-theme-set', colorTheme: HOSTILE })
    await shell.settle()

    // The user's own preference, resolved server-side — the same declarations
    // the server injects into the shell page at load.
    expect(shell.property('--hue')).toBe('140')
    expect(shell.property('--foreground')).toBe('oklch(0.145 0 0)')
    expect(shell.shellCalls()).toBeGreaterThan(0)
  })

  it('does not let an app override a server value by resending it', async () => {
    const shell = boot({ theme: '--foreground: oklch(0.145 0 0)' })
    shell.send({ type: 'color-theme-set', colorTheme: HOSTILE })
    await shell.settle()
    // A second attempt is no more privileged than the first.
    shell.send({ type: 'color-theme-set', colorTheme: HOSTILE })
    await shell.settle()

    expect(shell.property('--foreground')).toBe('oklch(0.145 0 0)')
    expect(shell.property('--background')).toBe('')
  })

  it('drops a theme the server no longer reports', async () => {
    const shell = boot({ theme: '--hue: 140' })
    shell.send({ type: 'color-theme-set', colorTheme: null })
    await shell.settle()
    expect(shell.property('--hue')).toBe('140')

    // Re-booting with an empty server theme must clear, not strand, the old
    // values — otherwise clearing a theme in settings leaves the chrome themed.
    const cleared = boot({ theme: '' })
    cleared.send({ type: 'color-theme-set', colorTheme: null })
    await cleared.settle()
    expect(cleared.property('--hue')).toBe('')
  })

  it('installs a real server theme without mangling its values', async () => {
    // Verbatim from a running instance. Values carrying commas, parentheses,
    // percentages and nested functions are the norm, not the exception — the
    // gradient alone would defeat a parser that split on anything but the
    // declaration separator.
    const REAL =
      '--hue: 250; --hue-chroma: 0.135; --radius-sm: calc(0.375rem - 4px); ' +
      '--background-image: radial-gradient(ellipse at top, color-mix(in oklch, var(--primary) 12%, transparent), transparent 70%); ' +
      'font-size: 112.5%'
    const shell = boot({ theme: REAL })
    shell.send({ type: 'color-theme-set', colorTheme: HOSTILE })
    await shell.settle()

    expect(shell.property('--hue')).toBe('250')
    expect(shell.property('--radius-sm')).toBe('calc(0.375rem - 4px)')
    expect(shell.property('--background-image')).toBe(
      'radial-gradient(ellipse at top, color-mix(in oklch, var(--primary) 12%, transparent), transparent 70%)'
    )
    // The user's own font-size preference is a standard property, not a custom
    // one, and must survive the same path.
    expect(shell.property('font-size')).toBe('112.5%')
  })

  it("still forwards the app's theme to the iframe", async () => {
    // An app styling its OWN document is its business, and cross-app theme
    // propagation depends on this relay — the fix must not break it.
    const shell = boot({ theme: '--hue: 140' })
    shell.send({ type: 'color-theme-set', colorTheme: HOSTILE })
    await shell.settle()

    const change = shell.posted.find((m) => m.type === 'color-theme-change')
    expect(change?.colorTheme).toEqual(HOSTILE)
  })
})

// "auto" is the DEFAULT appearance preference, so this is the common path, not
// a corner. It means follow the system — and the system moves while the tab is
// open (a desktop turning dark at sunset). Resolving once left the chrome at
// whatever the OS happened to be at page load until the user reloaded.
describe('shell appearance: auto keeps following the system', () => {
  it('follows a change after load', async () => {
    const scheme = stubColorScheme(false)
    const shell = boot({ appearance: 'auto' })
    await shell.settle()
    expect(appearance()).toBe('light')

    scheme.set(true)
    expect(appearance()).toBe('dark')

    // And back again — this is a preference, not a one-way latch.
    scheme.set(false)
    expect(appearance()).toBe('light')
  })

  it('follows a change after an app reports the preference', async () => {
    const scheme = stubColorScheme(false)
    const shell = boot({ appearance: 'light' })
    await shell.settle()

    // The settings app switches the user to auto mid-session; the page-load
    // resolution cannot have covered this case.
    shell.send({ type: 'theme-set', theme: 'auto' })
    await shell.settle()
    expect(appearance()).toBe('light')

    scheme.set(true)
    expect(appearance()).toBe('dark')
  })

  it('stops following once the user picks an explicit appearance', async () => {
    const scheme = stubColorScheme(false)
    const shell = boot({ appearance: 'auto' })
    await shell.settle()

    shell.send({ type: 'theme-set', theme: 'light' })
    await shell.settle()
    expect(appearance()).toBe('light')

    // The whole point of choosing light is that sunset does not undo it.
    scheme.set(true)
    expect(appearance()).toBe('light')
  })

  it('resolves an explicit preference without consulting the system', async () => {
    const scheme = stubColorScheme(true)
    const shell = boot({ appearance: 'dark' })
    await shell.settle()
    expect(appearance()).toBe('dark')

    shell.send({ type: 'theme-set', theme: 'light' })
    await shell.settle()
    expect(appearance()).toBe('light')
    scheme.set(false)
    expect(appearance()).toBe('light')
  })

  it('ignores an appearance value it does not recognise', async () => {
    // The value reaches here from an app's postMessage, so a junk string must
    // not clear the classes and leave the chrome unstyled.
    const scheme = stubColorScheme(true)
    const shell = boot({ appearance: 'auto' })
    await shell.settle()
    expect(appearance()).toBe('dark')

    shell.send({ type: 'theme-set', theme: 'chartreuse' })
    await shell.settle()
    expect(appearance()).toBe('dark')
    scheme.set(false)
    expect(appearance()).toBe('light')
  })
})

// The colour theme crosses the postMessage boundary, so its keys are full
// words. `hueBg` rides along for one release for app builds that still read
// it.
describe('shell theme: the colour theme names the background hue in full', () => {
  it('sends `background` in init, with the old key beside it for now', async () => {
    const shell = boot({ root: '--hue: 250; --hue-chroma: 0.1; --hue-bg: 250' })
    shell.send({ type: 'ready' })
    await shell.settle()
    const init = shell.posted.find((m) => m.type === 'init') as
      { colorTheme?: Record<string, unknown> } | undefined
    expect(init?.colorTheme?.background).toBe('250')
    expect(init?.colorTheme?.hueBg).toBe('250')
  })
})

// A theme is applied to the root one property at a time - the menu's own
// ThemeProvider removes and re-sets some thirty - and each record used to
// reach the frame as its own message, on which the frame re-rendered the
// whole app: 66 per theme change, and on every page load.
describe('shell theme: the frame hears each change once', () => {
  const kinds = (posted: Record<string, unknown>[], type: string) =>
    posted.filter((m) => m.type === type)

  it('sends nothing for a batch that leaves the theme as the frame has it', async () => {
    const shell = boot({ root: '--hue: 250; --hue-chroma: 0.1; --hue-bg: 250' })
    shell.send({ type: 'ready' })
    await shell.settle()
    expect(kinds(shell.posted, 'init')).toHaveLength(1)
    shell.posted.length = 0

    // The menu re-applying the same theme, a property at a time.
    const root = document.documentElement
    for (let i = 0; i < 33; i++) {
      root.style.removeProperty('--x' + i)
      root.style.setProperty('--x' + i, String(i))
    }
    await shell.settle()
    expect(kinds(shell.posted, 'color-theme-change')).toEqual([])
  })

  it('sends one message for a batch of appearance changes', async () => {
    const shell = boot()
    shell.send({ type: 'ready' })
    await shell.settle()
    shell.posted.length = 0

    const root = document.documentElement
    root.classList.add('dark')
    root.classList.remove('light')
    root.classList.add('dark')
    await shell.settle()
    expect(kinds(shell.posted, 'theme-change')).toEqual([
      { type: 'theme-change', theme: 'dark' },
    ])

    // And none for a class change that leaves it dark.
    root.classList.add('unrelated')
    await shell.settle()
    expect(kinds(shell.posted, 'theme-change')).toHaveLength(1)
  })

  it("forwards an app's new theme once, not again as the root is refreshed", async () => {
    const shell = boot({ theme: '--hue: 140; --foreground: oklch(0.145 0 0)' })
    shell.send({ type: 'ready' })
    await shell.settle()
    shell.posted.length = 0

    shell.send({ type: 'color-theme-set', colorTheme: HOSTILE })
    await shell.settle()
    expect(shell.shellCalls()).toBeGreaterThan(0)
    expect(kinds(shell.posted, 'color-theme-change')).toEqual([
      { type: 'color-theme-change', colorTheme: HOSTILE },
    ])
  })
})

// /_/shell names who is signed in, and the shell hands each frame the id and
// name in its init, so the page need not ask /_/identity itself.
describe('shell identity: init carries who is signed in', () => {
  const IDENTITY = {
    id: 'identity-alice',
    fingerprint: 'alicefp12',
    name: 'Alice',
    privacy: 'public',
  }

  it('gives the frame the id and name its own mint names, and nothing more', async () => {
    // The shell page loaded as Alice; the session has since been renamed (or
    // is someone else's), which the frame's own mint knows.
    const shell = boot({
      identity: IDENTITY,
      minted: { ...IDENTITY, name: 'Alice Renamed', extra: 'not passed on' },
    })
    shell.send({ type: 'ready' })
    await shell.settle()
    const init = shell.posted.find((m) => m.type === 'init')
    expect(init?.identity).toEqual({
      id: 'identity-alice',
      name: 'Alice Renamed',
    })
  })

  it('gives the menu the same', async () => {
    boot({ identity: IDENTITY })
    const ready = (
      window as unknown as {
        __mochi_shell_ready: Promise<{ identity?: unknown }>
      }
    ).__mochi_shell_ready
    expect((await ready).identity).toEqual({
      id: 'identity-alice',
      name: 'Alice',
    })
  })

  it('carries none from a server that reports none', async () => {
    const shell = boot()
    shell.send({ type: 'ready' })
    await shell.settle()
    const init = shell.posted.find((m) => m.type === 'init')
    expect(init?.identity).toBeNull()
  })
})
