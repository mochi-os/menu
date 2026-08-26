// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
function boot(
  options: {
    app?: string | null
    granted?: boolean
    token?: (app: string) => Promise<Record<string, unknown>>
  } = {}
) {
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
        let bodyApp: string | null = null
        try {
          bodyApp = JSON.parse(init?.body ?? '{}').app ?? null
        } catch {
          bodyApp = null
        }
        tokenApps.push(bodyApp)
        // A token handler lets a test hold responses and release them out of
        // order — the ordering IS what the navigation-race tests exercise.
        if (options.token) {
          return options.token(bodyApp ?? '').then((data) => ({
            ok: true,
            json: () => Promise.resolve(data),
          }))
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

// Every iframe the shell creates, with the messages it received: the shell
// swaps iframes mid-flight, so watching only the first cannot see where a stale
// init landed.
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

describe('shell ready: the init belongs to the iframe that asked', () => {
  // watch_frames spies on document.createElement; unstubAllGlobals does not
  // restore a spy, so without this it survives into the next test and replaces
  // the postMessage stub that test relies on.
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

// navigate-external into the app already loaded (a notification click for the
// current app) must move the iframe too and leave no stale lastNavigatedPath.
describe('shell navigate-external: staying inside the current app', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // After a swap the shell listens only to the NEW iframe.
  const sendFromCurrent = (data: Record<string, unknown>) => {
    const frame = document.getElementById('app-frame') as HTMLIFrameElement
    const event = new MessageEvent('message', { data })
    Object.defineProperty(event, 'source', { value: frame.contentWindow })
    window.dispatchEvent(event)
  }

  const currentSource = () =>
    (document.getElementById('app-frame') as HTMLIFrameElement).src

  it('reloads the iframe at the new path', async () => {
    const shell = boot({ app: 'feeds-entity' })
    await shell.start()
    expect(currentSource()).toContain('/feeds/')

    shell.send({ type: 'navigate-external', url: '/feeds/subscriptions' })
    await shell.settle()

    expect(shell.path()).toBe('/feeds/subscriptions')
    // The URL moving is not the point — the app has to actually go there.
    expect(currentSource()).toContain('/feeds/subscriptions')
  })

  it('does not push a duplicate entry when the app reports the path it was moved to', async () => {
    const shell = boot({ app: 'feeds-entity' })
    await shell.start()
    shell.send({ type: 'navigate-external', url: '/feeds/subscriptions' })
    await shell.settle()

    // The app's router settles on the new route and relays it back, exactly as
    // installShellNavigationSync does for every client-side navigation.
    const pushes = vi.spyOn(history, 'pushState')
    sendFromCurrent({ type: 'navigate', path: '/feeds/subscriptions' })
    await shell.settle()

    // Already the current path, so there is nothing to record. A second entry
    // here buries the one behind it and makes browser-back appear to do
    // nothing the first time it is pressed.
    expect(pushes).not.toHaveBeenCalled()
    expect(shell.path()).toBe('/feeds/subscriptions')
  })

  it('does not push a duplicate entry after crossing apps either', async () => {
    const shell = boot({ app: 'feeds-entity' })
    await shell.start()
    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()

    const pushes = vi.spyOn(history, 'pushState')
    sendFromCurrent({ type: 'navigate', path: '/settings/' })
    await shell.settle()

    // The cross-app branch survived on luck: a router's first relay is usually
    // a REPLACE, which quietly corrected the stale value. A push exposes it.
    expect(pushes).not.toHaveBeenCalled()
  })

  it('still refuses a navigate-external that names no app', async () => {
    // Companion: the same-app branch now reloads, so prove the guard above it
    // still rejects rather than reloading at a pathless target.
    const shell = boot({ app: 'feeds-entity' })
    await shell.start()
    const before = currentSource()

    shell.send({ type: 'navigate-external', url: '/' })
    await shell.settle()

    expect(shell.path()).toBe(HOME)
    expect(currentSource()).toBe(before)
  })
})

// A token response or refresh timer from before a cross-app navigation names
// the previous app; the navigation epoch must make it a no-op.
describe('shell token: a response from before a navigation is dead on arrival', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  type Deferred = {
    app: string
    resolve: (data: Record<string, unknown>) => void
    reject: (reason?: unknown) => void
  }

  // Holds every /_/token response for the test to release by hand — resolving
  // them out of arrival order is the point.
  function deferredTokens() {
    const pending: Deferred[] = []
    const token = (app: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.push({ app, resolve, reject })
      })
    const take = (app: string): Deferred => {
      const index = pending.findIndex((p) => p.app === app)
      if (index < 0) throw new Error('no pending token fetch for ' + app)
      return pending.splice(index, 1)[0]
    }
    return { token, take }
  }

  // After a swap the shell only listens to the NEW iframe, so post-navigation
  // messages must claim to come from whatever #app-frame is now.
  const sendFromCurrent = (data: Record<string, unknown>) => {
    const frame = document.getElementById('app-frame') as HTMLIFrameElement
    const event = new MessageEvent('message', { data })
    Object.defineProperty(event, 'source', { value: frame.contentWindow })
    window.dispatchEvent(event)
  }

  it('ignores a stale token response that resolves after crossing apps', async () => {
    const tokens = deferredTokens()
    const shell = boot({ granted: true, token: tokens.token })

    // 'ready' starts the feeds token fetch. Do not resolve it yet.
    shell.send({ type: 'ready' })
    await shell.settle()
    // Cross to settings while feeds' mint is in flight.
    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()

    // The settings response lands and the new iframe completes its handshake
    // (mic.start is dropped while a navigation is still in flight).
    tokens.take('settings').resolve({ app: 'settings-entity', token: 'settings-token' })
    await shell.settle()
    sendFromCurrent({ type: 'ready' })
    await shell.settle()
    tokens.take('settings').resolve({ app: 'settings-entity', token: 'settings-token' })
    await shell.settle()

    // Only now does the STALE feeds response arrive, out of order.
    tokens.take('feeds').resolve({ app: 'feeds-entity', token: 'feeds-token' })
    await shell.settle()

    // The mic gate consults the grant for the app on screen. Ungated, the
    // stale response overwrote the entity id and this check ran against
    // feeds' grants — the same id a NEW grant would be recorded under.
    sendFromCurrent({ type: 'mic.start', requestId: 1 })
    await shell.settle()
    expect(shell.checks).toEqual(['settings-entity'])
  })

  it('does not deliver a refresh token minted before the navigation', async () => {
    vi.useFakeTimers()
    const frames = watch_frames()
    const tokens = deferredTokens()
    const shell = boot({ token: tokens.token })

    shell.send({ type: 'ready' })
    await shell.settle()
    tokens.take('feeds').resolve({ app: 'feeds-entity', token: 'feeds-token' })
    await shell.settle() // init delivered; feeds' 10-minute refresh armed

    // The refresh fires and its mint goes in flight...
    vi.advanceTimersByTime(10 * 60 * 1000)
    await shell.settle()
    // ...and the user crosses to settings before it resolves.
    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()
    tokens.take('settings').resolve({ app: 'settings-entity', token: 'settings-token' })
    await shell.settle() // settings iframe mounted

    // The stale refresh resolves after the swap. Ungated, this posted feeds'
    // JWT into the settings iframe, which would adopt it for every request.
    tokens.take('feeds').resolve({ app: 'feeds-entity', token: 'feeds-token' })
    await shell.settle()

    const refreshes = frames.flatMap((f) => f.messages.filter((m) => m.type === 'token-refresh'))
    expect(refreshes).toEqual([])
  })

  it('re-arms the refresh for the NEW app when its token fetch fails', async () => {
    vi.useFakeTimers()
    const frames = watch_frames()
    const tokens = deferredTokens()
    const shell = boot({ token: tokens.token })

    shell.send({ type: 'ready' })
    await shell.settle()
    tokens.take('feeds').resolve({ app: 'feeds-entity', token: 'feeds-token' })
    await shell.settle() // feeds' refresh timer armed

    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()
    tokens.take('settings').reject(new Error('session expired'))
    await shell.settle() // iframe swapped anyway; the refresh must now belong to settings

    // Ten minutes later the surviving timer fires. Unfixed, this was still
    // feeds' timer: it minted a FEEDS token for the settings iframe.
    vi.advanceTimersByTime(10 * 60 * 1000)
    await shell.settle()
    expect(shell.tokenApps[shell.tokenApps.length - 1]).toBe('settings')

    tokens.take('settings').resolve({ app: 'settings-entity', token: 'settings-token' })
    await shell.settle()
    const refreshes = frames.flatMap((f) => f.messages.filter((m) => m.type === 'token-refresh'))
    expect(refreshes).toEqual([{ type: 'token-refresh', token: 'settings-token' }])
  })

  it('mints for the frame that asked, not the app the top URL has moved to', async () => {
    const tokens = deferredTokens()
    const shell = boot({ granted: true, token: tokens.token })

    // Feeds completes its handshake normally.
    shell.send({ type: 'ready' })
    await shell.settle()
    tokens.take('feeds').resolve({ app: 'feeds-entity', token: 'feeds-token' })
    await shell.settle()
    shell.posted.length = 0

    // Feeds asks the shell to cross to settings. The top URL moves at once,
    // but the frame is replaced only when the settings mint resolves - so
    // holding it leaves the FEEDS frame mounted under the SETTINGS URL.
    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()
    expect(shell.path()).toBe('/settings/')
    expect(document.getElementById('app-frame')).toBe(shell.iframe)

    // THE ATTACK: feeds sends 'ready' inside that window. It triggered the
    // navigation itself and nothing caps how many 'ready' messages it may
    // send, so the window is its to pick.
    shell.tokenApps.length = 0
    shell.send({ type: 'ready' })
    await shell.settle()

    // THE POINT: the mint names feeds - the app this frame was created for -
    // not settings, which is only what the address bar now says.
    expect(shell.tokenApps).toEqual(['feeds'])

    // And the credential that actually reaches the frame is feeds', so a
    // settings-scoped token never lands in the feeds iframe.
    tokens.take('feeds').resolve({ app: 'feeds-entity', token: 'feeds-token' })
    await shell.settle()
    const init = shell.posted.find((m) => m.type === 'init')
    expect(init?.token).toBe('feeds-token')
  })
})

// The watchdog exists so a frame that never sends 'ready' cannot strand the
// user on a dimmed page. It must not also rescue a transition it did not
// create: completeTransition clears `navigating`, and an app that simply
// withholds 'ready' can time a cross-app navigation so the load-time timer
// fires while the token fetch is still in flight and its own frame is still
// the mounted one.
describe('shell ready watchdog: only the navigation that armed it may complete it', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // A /_/token that never answers, so the navigation stays parked in the
  // window between `navigating = true` and swapIframe.
  function heldToken() {
    return { token: () => new Promise<Record<string, unknown>>(() => {}) }
  }

  async function watchdogFiresMidNavigation() {
    vi.useFakeTimers()
    const shell = boot({ app: 'feeds-entity', token: heldToken().token })
    // Deliberately no 'ready': sending it would clear the load-time timer.

    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()

    vi.advanceTimersByTime(READY_TIMEOUT_MS)
    await shell.settle()
    return shell
  }

  const READY_TIMEOUT_MS = 10000

  it('leaves the cross-app guard up, so storage stays refused', async () => {
    const shell = await watchdogFiresMidNavigation()
    shell.posted.length = 0

    shell.send({ type: 'storage.get', id: 1, key: 'k' })
    await shell.settle()

    // handleStorageGet returns before replying while `navigating` holds. A
    // reply here means the guard the other nine handlers share is down.
    expect(shell.posted.filter((m) => m.type === 'storage.result')).toEqual([])
  })

  it('leaves the outgoing frame dimmed and non-interactive', async () => {
    const shell = await watchdogFiresMidNavigation()

    // handleNavigateExternal dims the frame before the token fetch.
    // Completing a transition it does not own resets both properties, handing
    // the OUTGOING app an interactive frame under the INCOMING app's URL —
    // which the address bar already shows.
    expect(shell.iframe.style.pointerEvents).toBe('none')
    expect(shell.iframe.style.opacity).toBe('0.6')
  })

  it('still completes the transition it DOES own', async () => {
    vi.useFakeTimers()
    const shell = boot()
    const progress = document.getElementById('shell-progress') as HTMLElement
    expect(progress.style.opacity).toBe('1')

    // No navigation, so the epoch has not moved and this timer owns the
    // transition: a frame that never sends 'ready' must still be rescued.
    vi.advanceTimersByTime(READY_TIMEOUT_MS)
    await shell.settle()

    expect(progress.style.opacity).toBe('0')
  })
})

// `language-set` is sent by lib/web's shellSetLanguage, which ships in every
// app's bundle. It used to make the shell write an origin-wide mochi_language
// cookie — the capability a.cookie.* was removed to close. The server now
// writes that cookie from /_/shell; the shell only broadcasts.
describe('shell language-set: broadcasts, never writes a cookie', () => {
  it('does not write mochi_language', async () => {
    const shell = boot({ app: 'feeds-entity' })
    await shell.start()

    shell.send({ type: 'language-set', language: 'fr' })
    await shell.settle()

    expect(document.cookie).not.toContain('mochi_language')
  })

  it('still broadcasts the change to the iframe', async () => {
    const shell = boot({ app: 'feeds-entity' })
    await shell.start()

    shell.send({ type: 'language-set', language: 'fr' })
    await shell.settle()

    const change = shell.posted.filter((m) => m.type === 'language-change')
    expect(change).toEqual([{ type: 'language-change', language: 'fr' }])
  })

  it('refuses a tag it cannot parse, rather than storing it', async () => {
    const shell = boot({ app: 'feeds-entity' })
    await shell.start()
    localStorage.setItem('mochi:language', 'en')

    // Each of these reaches localStorage and every open iframe if accepted.
    for (const bad of ['hello world', 'EN-GB', 'a'.repeat(1024), '', 'en' + '-aa'.repeat(1000)]) {
      shell.send({ type: 'language-set', language: bad })
    }
    // A non-string would previously be stored and re-broadcast as-is.
    shell.send({ type: 'language-set', language: { toString: () => 'en' } })
    await shell.settle()

    expect(shell.posted.filter((m) => m.type === 'language-change')).toEqual([])
    expect(localStorage.getItem('mochi:language')).toBe('en')
  })

  it('accepts the tags the project actually ships', async () => {
    const shell = boot({ app: 'feeds-entity' })
    await shell.start()

    for (const good of ['en', 'pt-br', 'zh-hant', 'es-419', 'en-x-pseudo-rtl']) {
      shell.send({ type: 'language-set', language: good })
    }
    await shell.settle()

    expect(
      shell.posted.filter((m) => m.type === 'language-change').map((m) => m.language)
    ).toEqual(['en', 'pt-br', 'zh-hant', 'es-419', 'en-x-pseudo-rtl'])
    expect(localStorage.getItem('mochi:language')).toBe('en-x-pseudo-rtl')
  })
})

// The menu app's push and consent hooks need to know when the loaded app
// CHANGES, not merely what it currently is. Reading the global cannot tell an
// answer resolved for this app from one resolved after a navigation replaced
// it, so shell.js announces every write.
describe('shell app id: every change is announced', () => {
  // shell.js runs on the top window, which is jsdom's global here.
  function record() {
    const seen: Array<string | null> = []
    const listener = (event: Event) => {
      seen.push((event as CustomEvent).detail?.app ?? null)
    }
    window.addEventListener('mochi-shell-app-changed', listener)
    listeners.push(listener)
    return seen
  }
  let listeners: Array<(event: Event) => void> = []
  beforeEach(() => {
    listeners = []
    delete (window as unknown as { __mochi_shell?: unknown }).__mochi_shell
  })
  afterEach(() => {
    listeners.forEach((l) => window.removeEventListener('mochi-shell-app-changed', l))
  })

  // The default boot resolves no app id at all, so each of these names one.
  const perApp = { token: async (app: string) => ({ app: `${app}-entity`, token: 'app-token' }) }

  it('announces the id when the first token resolves', async () => {
    const seen = record()
    const shell = boot(perApp)
    await shell.start()

    expect(seen).toEqual(['feeds-entity'])
  })

  it('announces the null and then the next app across a navigation', async () => {
    const shell = boot(perApp)
    await shell.start()
    const seen = record()

    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()

    // Null first: the outgoing app's id must not survive into the incoming
    // app's checks, and a consumer waiting on the change needs to see the gap.
    expect(seen).toEqual([null, 'settings-entity'])
  })

  it('says nothing for a navigation within the same app', async () => {
    const shell = boot(perApp)
    await shell.start()
    const seen = record()

    shell.send({ type: 'navigate', path: '/feeds/subscriptions' })
    await shell.settle()

    // The app did not change, so no consumer should be told that it did.
    expect(seen).toEqual([])
  })
})

describe('shell download: the app comes from the frame, not the top URL', () => {
  // Whether the shell FETCHED is the guard's own outcome; whether the download
  // then completes depends on blob plumbing this harness does not model.
  function fetched(url: string) {
    return vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes(url))
  }

  it('fetches a URL in the frame stamped app', async () => {
    const shell = boot()
    await shell.start()

    shell.send({ type: 'download', id: 1, url: '/feeds/report.csv' })
    await shell.settle()

    expect(fetched('/feeds/report.csv')).toBe(true)
  })

  it('refuses a URL naming another app', async () => {
    const shell = boot()
    await shell.start()

    shell.send({ type: 'download', id: 2, url: '/settings/secrets.csv' })
    await shell.settle()

    expect(fetched('/settings/secrets.csv')).toBe(false)
    expect(shell.posted).toContainEqual({ type: 'download.result', id: 2, ok: false })
  })

  it('refuses when the frame carries no app stamp', async () => {
    const shell = boot()
    await shell.start()
    // An unstamped frame must get nothing rather than whatever the top URL says.
    delete shell.iframe.dataset.app

    shell.send({ type: 'download', id: 3, url: '/feeds/report.csv' })
    await shell.settle()

    expect(fetched('/feeds/report.csv')).toBe(false)
    expect(shell.posted).toContainEqual({ type: 'download.result', id: 3, ok: false })
  })
})

describe('shell title: typed and bounded', () => {
  it('takes a string', async () => {
    const shell = boot()
    await shell.start()
    shell.send({ type: 'title', title: 'Feeds' })
    await shell.settle()
    expect(document.title).toContain('Feeds')
  })

  it('ignores a non-string, rather than rendering [object Object]', async () => {
    const shell = boot()
    await shell.start()
    shell.send({ type: 'title', title: 'Feeds' })
    await shell.settle()

    shell.send({ type: 'title', title: { toString: () => 'evil' } })
    await shell.settle()
    expect(document.title).not.toContain('[object Object]')
    expect(document.title).toContain('Feeds')
  })

  it('caps an over-long title', async () => {
    const shell = boot()
    await shell.start()
    shell.send({ type: 'title', title: 'x'.repeat(5000) })
    await shell.settle()
    expect(document.title.length).toBeLessThanOrEqual(300)
  })
})

describe('shell navigate-back: never past the entry the shell started at', () => {
  it('refuses when the shell has pushed nothing', async () => {
    const shell = boot()
    await shell.start()
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})

    shell.send({ type: 'navigate-back' })
    await shell.settle()

    expect(back).not.toHaveBeenCalled()
    back.mockRestore()
  })

  it('pops an entry the shell pushed, then refuses again', async () => {
    const shell = boot()
    await shell.start()
    shell.send({ type: 'navigate', path: '/feeds/subscriptions' })
    await shell.settle()

    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    shell.send({ type: 'navigate-back' })
    await shell.settle()
    expect(back).toHaveBeenCalledTimes(1)

    // A loop must not walk the user off the site.
    for (let i = 0; i < 5; i++) shell.send({ type: 'navigate-back' })
    await shell.settle()
    expect(back).toHaveBeenCalledTimes(1)
    back.mockRestore()
  })
})

describe('shell storage.set: bounded so one app cannot fill the origin pool', () => {
  it('stores an ordinary value', async () => {
    const shell = boot()
    await shell.start()
    shell.send({ type: 'storage.set', key: 'view', value: 'grid' })
    await shell.settle()
    expect(localStorage.getItem('app:feeds:view')).toBe('grid')
  })

  it('refuses a value beyond the cap', async () => {
    const shell = boot()
    await shell.start()
    shell.send({ type: 'storage.set', key: 'bulk', value: 'x'.repeat(200 * 1024) })
    await shell.settle()
    expect(localStorage.getItem('app:feeds:bulk')).toBeNull()
  })

  it('refuses a non-string value', async () => {
    const shell = boot()
    await shell.start()
    shell.send({ type: 'storage.set', key: 'n', value: 42 })
    await shell.settle()
    expect(localStorage.getItem('app:feeds:n')).toBeNull()
  })
})
