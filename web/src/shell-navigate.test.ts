// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Same approach as shell-webauthn.test.ts: public/shell.js runs in the top
// window, outside the React tree and outside the bundler, so it is loaded as
// source and evaluated against a jsdom document shaped like the shell page.
const SHELL = readFileSync(resolve(__dirname, '../public/shell.js'), 'utf8')

const HOME = '/feeds/'

// boot mounts the shell on /feeds/ and returns handles for driving it plus the
// effects worth asserting: what the top URL became, which app the shell
// switched to, and which apps it minted tokens for. The refusals under test
// are silent - no reply is posted - so the effect is the only witness.
function boot(options: { app?: string | null; granted?: boolean } = {}) {
  const app = options.app === undefined ? null : options.app
  const granted = options.granted ?? false
  document.body.innerHTML =
    '<div id="app-container"></div><div id="menu"></div><div id="shell-progress"></div>'
  window.history.replaceState({}, '', HOME)

  const tokenApps: unknown[] = []
  // Every permission check the shell made. The no-app-id case asserts on this
  // being EMPTY: with no resolved app there is no grant to consult, and asking
  // anyway would risk answering with the previous app's.
  const checks: (string | null)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { body?: string }) => {
      if (String(url).indexOf('/menu/-/permissions/check') >= 0) {
        checks.push(new URLSearchParams(init?.body ?? '').get('app'))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { granted } }),
        })
      }
      if (String(url).indexOf('/_/token') >= 0) {
        try {
          tokenApps.push(JSON.parse(init?.body ?? '{}').app)
        } catch {
          tokenApps.push(null)
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(app ? { app, token: 'app-token' } : { token: 'app-token' }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) })
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
  // from there - which is exactly what a hostile app in that iframe can do.
  const send = (data: Record<string, unknown>) => {
    const event = new MessageEvent('message', { data })
    Object.defineProperty(event, 'source', { value: source })
    window.dispatchEvent(event)
  }

  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  const path = () => window.location.pathname + window.location.search + window.location.hash

  // 'ready' is what makes the shell fetch the token, which is the only thing
  // that resolves the app id the mic gate later checks a grant against.
  const start = async () => {
    send({ type: 'ready' })
    await settle()
    posted.length = 0
  }

  return { send, settle, path, tokenApps, iframe, posted, checks, start }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
})

// Origin-crossing forms, plus the ones that stay on-origin but land in another
// app. The second group is the point: an origin check alone passes them all.
const OFF_ORIGIN = [
  ['absolute', 'https://evil.example/steal'],
  ['protocol-relative', '//evil.example/steal'],
  ['backslash', '\\\\evil.example/steal'],
  ['javascript', 'javascript:alert(1)'],
]

const OTHER_APP = [
  ['plain', '/settings/'],
  ['traversal', '/feeds/../settings/'],
  ['encoded traversal', '/feeds/%2e%2e/settings/'],
  ['absolute same-origin', 'http://localhost:3000/settings/'],
]

describe('shell navigate: stays inside the current app', () => {
  it('moves the top URL for a path in the SAME app', async () => {
    const shell = boot()
    shell.send({ type: 'navigate', path: '/feeds/subscriptions' })
    await shell.settle()
    // Companion to every refusal below: without this, "the URL did not change"
    // would pass just as well against a handler that never ran at all.
    expect(shell.path()).toBe('/feeds/subscriptions')
  })

  it.each(OTHER_APP)('refuses a %s path that resolves to another app', async (_name, url) => {
    const shell = boot()
    shell.send({ type: 'navigate', path: url })
    await shell.settle()
    // Moving the top URL to another app while this iframe stays mounted would
    // let the next 'ready' mint THAT app's token and hand it to the iframe
    // that asked - the cross-app token theft this check exists to stop.
    expect(shell.path()).toBe(HOME)
  })

  it.each(OFF_ORIGIN)('refuses an %s URL', async (_name, url) => {
    const shell = boot()
    shell.send({ type: 'navigate', path: url })
    await shell.settle()
    expect(shell.path()).toBe(HOME)
  })

  it('reads the app from the RESOLVED path, not the raw string', async () => {
    const shell = boot()
    // The trap sameOriginTarget was written for: an absolute URL carries no
    // leading "/<app>" for getAppNameFromPath to match, so reading the app off
    // the raw string yields '' - and every comparison against '' passes.
    shell.send({ type: 'navigate', path: 'http://localhost:3000/settings/danger' })
    await shell.settle()
    expect(shell.path()).toBe(HOME)
  })
})

describe('shell navigate-external: crosses apps, but the target must name one', () => {
  it('switches app for a same-origin path naming another app', async () => {
    const shell = boot()
    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()
    // Crossing apps IS the point here, so this is the positive case.
    expect(shell.path()).toBe('/settings/')
    expect(shell.tokenApps).toContain('settings')
  })

  it.each(OFF_ORIGIN)('refuses an %s URL', async (_name, url) => {
    const shell = boot()
    shell.send({ type: 'navigate-external', url })
    await shell.settle()
    expect(shell.path()).toBe(HOME)
    expect(shell.tokenApps).not.toContain('evil.example')
  })

  it('refuses a same-origin URL that names no app', async () => {
    const shell = boot()
    shell.send({ type: 'navigate-external', url: '/' })
    await shell.settle()
    // An empty app name keys storage on a shared 'app::' prefix every app
    // would then read, and asks for a token for no app at all.
    expect(shell.path()).toBe(HOME)
    expect(shell.tokenApps).not.toContain('')
  })
})

describe('shell navigate-top: same-origin only', () => {
  it.each(OFF_ORIGIN)('does not send the top window to an %s URL', async (_name, url) => {
    const shell = boot()
    const before = shell.path()
    shell.send({ type: 'navigate-top', url })
    await shell.settle()
    // Navigating the trusted top window is privileged; an app in the sandboxed
    // iframe does not get to choose an off-origin destination. This is the
    // handler market's checkout reaches, which is why a rejected Stripe URL
    // surfaces as a dead button rather than a redirect.
    expect(shell.path()).toBe(before)
  })
})

describe('shell navigate handlers ignore a message with no target', () => {
  it.each([
    ['navigate', 'path'],
    ['navigate-external', 'url'],
    ['navigate-top', 'url'],
  ])('%s with an empty %s', async (type, field) => {
    const shell = boot()
    shell.send({ type, [field]: '' })
    await shell.settle()
    expect(shell.path()).toBe(HOME)
  })
})

// The storage proxy. Apps in the sandbox have an opaque origin and no usable
// localStorage of their own, so the shell holds it for them - which makes the
// prefix the only thing keeping one app out of another's values.
describe('shell storage proxy namespaces by app', () => {
  afterEach(() => localStorage.clear())

  it('writes and reads under app:<name>:', async () => {
    const shell = boot()
    shell.send({ type: 'storage.set', key: 'view', value: 'grid' })
    await shell.settle()
    expect(localStorage.getItem('app:feeds:view')).toBe('grid')
    // Never the bare key: that is the slot a differently-loaded copy of this
    // app, or another app entirely, would collide on.
    expect(localStorage.getItem('view')).toBeNull()
  })

  it('removes the namespaced key', async () => {
    const shell = boot()
    shell.send({ type: 'storage.set', key: 'draft', value: 'x' })
    await shell.settle()
    shell.send({ type: 'storage.remove', key: 'draft' })
    await shell.settle()
    expect(localStorage.getItem('app:feeds:draft')).toBeNull()
  })

  it('does not read another app\'s value', async () => {
    const shell = boot()
    localStorage.setItem('app:settings:secret', 'other-app-value')
    localStorage.setItem('app:feeds:secret', 'mine')
    shell.send({ type: 'storage.set', key: 'secret', value: 'mine-again' })
    await shell.settle()
    // The write landed in this app's slot and left the neighbour alone.
    expect(localStorage.getItem('app:feeds:secret')).toBe('mine-again')
    expect(localStorage.getItem('app:settings:secret')).toBe('other-app-value')
  })
})

// The microphone bridge. Like WebAuthn, the capability lives in the top window
// and the sandboxed app cannot reach it directly, so the shell brokers it -
// and every path that is not an explicit grant must end with the microphone
// closed rather than open.
describe('shell mic bridge fails closed', () => {
  // The menu component normally answers this; here the test plays that part so
  // the 60s fail-closed timeout never has to run. Registered listeners are
  // removed after each test: left attached they answer the NEXT test's dialog
  // too, which silently turned the cancellation case below into a denial.
  let consentListeners: EventListener[] = []
  afterEach(() => {
    consentListeners.forEach((l) =>
      window.removeEventListener('mochi-shell-permission-request', l)
    )
    consentListeners = []
  })

  function answerConsent(result: 'granted' | 'denied') {
    const listener = ((e: CustomEvent) => {
      window.dispatchEvent(
        new CustomEvent('mochi-shell-permission-result', {
          detail: { id: e.detail.id, result },
        })
      )
    }) as EventListener
    consentListeners.push(listener)
    window.addEventListener('mochi-shell-permission-request', listener)
  }

  const micResult = (posted: Record<string, unknown>[]) =>
    posted.find((m) => m.type === 'mic.result') as
      | { ok: boolean; error?: { name: string }; cancelled?: boolean }
      | undefined

  it('refuses when the user denies consent', async () => {
    const shell = boot()
    answerConsent('denied')
    shell.send({ type: 'mic.start', requestId: 1 })
    await shell.settle()
    const result = micResult(shell.posted)
    expect(result?.ok).toBe(false)
    expect(result?.error?.name).toBe('NotAllowedError')
  })

  it('refuses a second request while one is already open', async () => {
    const shell = boot()
    // No consent answer, so the first request stays open.
    shell.send({ type: 'mic.start', requestId: 1 })
    shell.send({ type: 'mic.start', requestId: 2 })
    await shell.settle()
    const refused = shell.posted.find(
      (m) => m.type === 'mic.result' && m.requestId === 2
    ) as { ok: boolean; error?: { name: string } } | undefined
    expect(refused?.ok).toBe(false)
    expect(refused?.error?.name).toBe('InvalidStateError')
  })
})

describe('shell mic bridge: the remaining fail-closed paths', () => {
  const micResult = (posted: Record<string, unknown>[], requestId: number) =>
    posted.find((m) => m.type === 'mic.result' && m.requestId === requestId) as
      | { ok: boolean; cancelled?: boolean; error?: { name: string } }
      | undefined

  let consentListeners: EventListener[] = []
  afterEach(() => {
    consentListeners.forEach((l) =>
      window.removeEventListener('mochi-shell-permission-request', l)
    )
    consentListeners = []
  })

  function onConsentRequest(handler: (id: unknown) => void) {
    const listener = ((e: CustomEvent) => {
      handler(e.detail.id)
    }) as EventListener
    consentListeners.push(listener)
    window.addEventListener('mochi-shell-permission-request', listener)
  }

  function answer(id: unknown, result: 'granted' | 'denied') {
    window.dispatchEvent(
      new CustomEvent('mochi-shell-permission-result', { detail: { id, result } })
    )
  }

  it('does not open the microphone when a stop lands while consent is open', async () => {
    const shell = boot()
    let consentId: unknown = null
    onConsentRequest((id) => {
      consentId = id
    })

    shell.send({ type: 'mic.start', requestId: 7 })
    await shell.settle()
    expect(consentId).not.toBeNull()

    // The user is still looking at the dialog when the app gives up.
    shell.send({ type: 'mic.stop', requestId: 7 })
    // Consent then resolves POSITIVELY - the dangerous ordering, because the
    // grant arrives after the request it belongs to was abandoned.
    answer(consentId, 'granted')
    await shell.settle()

    const result = micResult(shell.posted, 7)
    expect(result?.ok).toBe(false)
    expect(result?.cancelled).toBe(true)
  })

  it('consults no grant when no app id has resolved yet', async () => {
    // No 'ready', so /_/token never answered and currentAppEntity is unset -
    // the state a cross-app navigation passes through.
    const shell = boot({ granted: true })
    onConsentRequest((id) => answer(id, 'denied'))

    shell.send({ type: 'mic.start', requestId: 8 })
    await shell.settle()

    // The grant is never consulted: with no resolved app there is nothing to
    // ask about, and asking anyway risks answering with the previous app's.
    expect(shell.checks).toEqual([])
    expect(micResult(shell.posted, 8)?.ok).toBe(false)
  })

  it('consults the resolved app grant once one exists', async () => {
    // Companion: the same code path DOES check when an app id is present, so
    // the empty checks above mean "no app id", not "never checks".
    const shell = boot({ app: 'app-entity-id', granted: true })
    await shell.start()

    shell.send({ type: 'mic.start', requestId: 9 })
    await shell.settle()

    expect(shell.checks).toEqual(['app-entity-id'])
  })
})

// The 'ready' handler mints a token for the app named by the CURRENT top URL
// and posts it after two awaits. `iframe` is reassigned by a cross-app
// navigation, so without pinning the requester the init - carrying that app's
// JWT - was delivered to whichever iframe happened to be mounted by then. The
// same fetch sets currentAppEntity, which names the app in the consent dialog
// and is what a granted permission is recorded against.
describe('shell ready: the init belongs to the iframe that asked', () => {
  // watch_frames spies on document.createElement; unstubAllGlobals does not
  // restore a spy, so without this it survives into the next test and replaces
  // the postMessage stub that test relies on.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Every iframe the shell creates, with the messages it received. The shell
  // swaps iframes mid-flight, so watching only the first one cannot see where
  // a stale init landed.
  function watch_frames() {
    const frames: { messages: Record<string, unknown>[] }[] = []
    const create = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...rest: unknown[]) => {
      const element = create(tag, ...(rest as [])) as HTMLElement
      if (tag === 'iframe') {
        const record = { messages: [] as Record<string, unknown>[] }
        frames.push(record)
        queueMicrotask(() => {
          const window_ = (element as HTMLIFrameElement).contentWindow
          if (window_) {
            window_.postMessage = ((msg: Record<string, unknown>) => {
              record.messages.push(msg)
            }) as typeof window_.postMessage
          }
        })
      }
      return element
    })
    return frames
  }

  it('drops an init whose iframe was replaced while the token was in flight', async () => {
    const frames = watch_frames()
    const shell = boot({ app: 'feeds-entity' })

    // 'ready' starts the token fetch for feeds. Do NOT settle: the race is the
    // window between this and the fetch resolving.
    shell.send({ type: 'ready' })
    // Cross to another app while it is in flight — the shell mounts a new iframe.
    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()

    // NOTHING should have received an init. The feeds iframe asked, but was
    // replaced before the token arrived; the settings iframe that replaced it
    // never sent 'ready', so it has asked for nothing. Before the requester
    // was pinned, the settings iframe received the FEEDS token here.
    const inits = frames.flatMap((f) => f.messages.filter((m) => m.type === 'init'))
    expect(inits).toEqual([])
  })

  it('still delivers the init when nothing navigated', async () => {
    const shell = boot({ app: 'feeds-entity' })
    shell.send({ type: 'ready' })
    await shell.settle()
    expect(shell.posted.filter((m) => m.type === 'init')).toHaveLength(1)
  })
})

// getAppNameFromPath('/') is '', and the guard read `target.app && ...`, so a
// request to move the top URL to the root skipped the one check written to
// stop an app relocating the URL to another app.
describe('shell navigate: an empty app name is not a free pass', () => {
  it('refuses a navigate to the root from inside an app', async () => {
    const shell = boot()
    await shell.start()
    shell.send({ type: 'navigate', path: '/' })
    await shell.settle()
    expect(shell.path()).toBe(HOME)
  })
})
