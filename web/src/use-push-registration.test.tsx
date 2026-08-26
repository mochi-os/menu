// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { push } from '@mochi/web'
import { usePushRegistration } from './use-push-registration'

// The hook only installs a window 'message' listener; render it bare.
function Harness() {
  usePushRegistration()
  return null
}

let appFrame: HTMLIFrameElement
let granted: boolean
let checks: Array<{ app: string; permission: string }>

beforeEach(() => {
  appFrame = document.createElement('iframe')
  appFrame.id = 'app-frame'
  document.body.appendChild(appFrame)

  // shell.js publishes the app id the SERVER resolved for the current path.
  ;(window as { __mochi_shell?: { appId?: string | null } }).__mochi_shell = { appId: 'app-1' }

  granted = true
  checks = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/permissions/check')) {
        const body = new URLSearchParams(String(init?.body ?? ''))
        checks.push({ app: body.get('app') ?? '', permission: body.get('permission') ?? '' })
        return { ok: true, json: async () => ({ data: { granted } }) } as Response
      }
      // Account bookkeeping the unsubscribe path performs once it actually
      // reaches a subscription. Left throwing, the handler would answer
      // 'error' and the reply assertions could not tell that apart from the
      // hang they exist to catch.
      if (String(url).includes('/push/accounts/')) {
        return { ok: true, json: async () => ({ data: [] }) } as Response
      }
      throw new Error('unexpected fetch: ' + url)
    })
  )

  // jsdom has no service worker; the unsubscribe path needs one to reach its end.
  // `ready` is kept alongside getRegistration so a reintroduced `await
  // navigator.serviceWorker.ready` still passes here rather than failing for
  // the wrong reason — the no-registration test below is what catches it.
  setServiceWorker({ pushManager: { getSubscription: async () => null } })
})

// Shape the service worker container. Passing null models the state a browser
// is in when nothing was ever registered: getRegistration resolves undefined,
// and `ready` is a promise that NEVER settles — which is precisely the hang
// under test, so it must never settle here either.
function setServiceWorker(registration: unknown) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: registration ? Promise.resolve(registration) : new Promise(() => {}),
      getRegistration: async () => registration ?? undefined,
    },
  })
}

afterEach(() => {
  appFrame.remove()
  delete (window as { __mochi_shell?: unknown }).__mochi_shell
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function send(data: unknown) {
  const source = appFrame.contentWindow as WindowProxy
  const post = vi.spyOn(source, 'postMessage').mockImplementation(() => {})
  window.dispatchEvent(new MessageEvent('message', { data, source }))
  return post
}

describe('usePushRegistration source guard', () => {
  it('ignores push-subscribe from a window that is not the app iframe', async () => {
    const requestPermission = vi
      .spyOn(push, 'requestPermission')
      .mockResolvedValue('granted')
    render(<Harness />)

    // A stale popup / nested frame the app opened, not #app-frame.
    const rogue = { postMessage: vi.fn() }
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'push-subscribe', id: 1 },
        source: rogue as unknown as WindowProxy,
      })
    )

    // Give any (incorrectly-scheduled) async handler a tick to run.
    await Promise.resolve()
    await Promise.resolve()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(rogue.postMessage).not.toHaveBeenCalled()
  })

  it('processes push-subscribe from the app iframe', async () => {
    const requestPermission = vi
      .spyOn(push, 'requestPermission')
      .mockResolvedValue('denied')
    render(<Harness />)

    const post = send({ type: 'push-subscribe', id: 2 })

    // The message is accepted, so permission is requested; denied short-circuits
    // and answers the requesting iframe.
    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-result', id: 2, ok: false, reason: 'denied' },
        '*'
      )
    })
  })
})

describe('usePushRegistration permission gate', () => {
  it('checks notifications/write against the shell-resolved app id', async () => {
    vi.spyOn(push, 'requestPermission').mockResolvedValue('denied')
    render(<Harness />)

    send({ type: 'push-subscribe', id: 10 })

    await waitFor(() => {
      expect(checks).toEqual([{ app: 'app-1', permission: 'notifications/write' }])
    })
  })

  it('refuses push-unsubscribe when the app does not hold the permission', async () => {
    granted = false
    render(<Harness />)

    const post = send({ type: 'push-unsubscribe', id: 11 })

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-unsubscribe-result', id: 11, ok: false, reason: 'forbidden' },
        '*'
      )
    })
  })

  it('allows push-unsubscribe when the app holds the permission', async () => {
    render(<Harness />)

    // The companion to the refusal above: without this the "forbidden" test
    // would pass just as well if the handler never ran at all.
    const post = send({ type: 'push-unsubscribe', id: 12 })

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-unsubscribe-result', id: 12, ok: true },
        '*'
      )
    })
  })

  it('refuses push-status when the app does not hold the permission', async () => {
    granted = false
    vi.spyOn(push, 'getPermission').mockReturnValue('default')
    render(<Harness />)

    const post = send({ type: 'push-status', id: 13 })

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-status-result', id: 13, ok: false, reason: 'forbidden' },
        '*'
      )
    })
  })

  it('allows push-status when the app holds the permission', async () => {
    vi.spyOn(push, 'getPermission').mockReturnValue('default')
    render(<Harness />)

    const post = send({ type: 'push-status', id: 14 })

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-status-result', id: 14, ok: true, subscribed: false, permission: 'default' },
        '*'
      )
    })
  })

  it('answers push-unsubscribe when no service worker is registered', async () => {
    // No service worker is the ordinary state for anyone who never enabled
    // push; the handler must answer rather than await serviceWorker.ready,
    // which never settles.
    setServiceWorker(null)
    render(<Harness />)

    const post = send({ type: 'push-unsubscribe', id: 20 })

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-unsubscribe-result', id: 20, ok: true },
        '*'
      )
    })
  })

  it('answers push-status when permission is granted but nothing is registered', async () => {
    // Notification permission is origin-scoped and outlives the service worker,
    // so clearing site data leaves exactly this combination — and status is the
    // call the settings screen makes on load.
    setServiceWorker(null)
    vi.spyOn(push, 'getPermission').mockReturnValue('granted')
    vi.spyOn(push, 'isSupported').mockResolvedValue(true)
    render(<Harness />)

    const post = send({ type: 'push-status', id: 21 })

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-status-result', id: 21, ok: true, subscribed: false, permission: 'granted' },
        '*'
      )
    })
  })

  it('still unsubscribes a live subscription when one exists', async () => {
    // Companion to the no-registration cases: the fix must not turn the real
    // unsubscribe into a no-op that merely answers.
    const unsubscribe = vi.fn(async () => true)
    setServiceWorker({
      pushManager: {
        getSubscription: async () => ({ endpoint: 'https://push.example/x', unsubscribe }),
      },
    })
    // jsdom has no PushManager, so isSupported() is false and the subscription
    // branch would be skipped for a reason that has nothing to do with this
    // test. Model a browser that can actually take a subscription.
    vi.spyOn(push, 'isSupported').mockResolvedValue(true)
    render(<Harness />)

    const post = send({ type: 'push-unsubscribe', id: 22 })

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-unsubscribe-result', id: 22, ok: true },
        '*'
      )
    })
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('refuses push-subscribe when the permission check itself fails', async () => {
    // Fail closed: a server that will not answer is not a grant.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }) as Response)
    )
    const requestPermission = vi.spyOn(push, 'requestPermission').mockResolvedValue('granted')
    render(<Harness />)

    const post = send({ type: 'push-subscribe', id: 15 })

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-result', id: 15, ok: false, reason: 'forbidden' },
        '*'
      )
    })
    expect(requestPermission).not.toHaveBeenCalled()
  })
})

// The app id used for the permission check used to be re-read from the global
// long after the request arrived — up to 5s, because the resolver polled for
// it. shell.js rewrites that global on every navigation, so an app with no
// grant could have its request judged against the NEXT app's grant.
describe('usePushRegistration binds the answer to the frame that asked', () => {
  // A frame asking during its first render beats /_/token, which is the whole
  // reason the resolver waits at all.
  function pending() {
    ;(window as { __mochi_shell?: { appId?: string | null } }).__mochi_shell = { appId: null }
  }

  function announce(app: string | null) {
    window.dispatchEvent(new CustomEvent('mochi-shell-app-changed', { detail: { app } }))
  }

  // What shell.js does on a cross-app navigation: a NEW element takes the id,
  // the old one keeps its window alive but loses #app-frame.
  let arrived: HTMLIFrameElement[]
  beforeEach(() => {
    arrived = []
  })
  // Not inline in each test: an assertion that throws would skip the cleanup
  // and leak a second #app-frame into the next test, where the message-time
  // frame check would then refuse for a reason that test is not about.
  afterEach(() => {
    arrived.forEach((frame) => frame.remove())
  })

  function navigate() {
    appFrame.removeAttribute('id')
    const next = document.createElement('iframe')
    next.id = 'app-frame'
    document.body.appendChild(next)
    arrived.push(next)
    return next
  }

  it('waits for the shell to announce an id rather than polling for it', async () => {
    const requestPermission = vi.spyOn(push, 'requestPermission').mockResolvedValue('denied')
    pending()
    render(<Harness />)

    const post = send({ type: 'push-subscribe', id: 7 })
    announce('app-1')

    // Resolves off the announcement. A poll would still be sleeping.
    await waitFor(() => {
      expect(checks).toEqual([{ app: 'app-1', permission: 'notifications/write' }])
    })
    expect(requestPermission).toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith(
      { type: 'push-result', id: 7, ok: false, reason: 'denied' },
      '*'
    )
  })

  it('refuses when the app changed while the id was being resolved', async () => {
    const requestPermission = vi.spyOn(push, 'requestPermission').mockResolvedValue('granted')
    pending()
    render(<Harness />)

    // App A asks on first render, then drives a navigation to app B — which it
    // may do, navigate-external accepts any same-origin URL naming an app.
    const post = send({ type: 'push-subscribe', id: 8 })
    navigate()
    announce('app-2')

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-result', id: 8, ok: false, reason: 'forbidden' },
        '*'
      )
    })
    // App B's grant was never even consulted on app A's behalf.
    expect(checks).toEqual([])
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('refuses an unsubscribe the same way, before it touches the account', async () => {
    // This is the one that acts on the whole device: removeBrowserAccount runs
    // regardless of where the reply goes.
    pending()
    render(<Harness />)

    const post = send({ type: 'push-unsubscribe', id: 9 })
    navigate()
    announce('app-2')

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-unsubscribe-result', id: 9, ok: false, reason: 'forbidden' },
        '*'
      )
    })
    expect(checks).toEqual([])
  })

  it('refuses push-status the same way', async () => {
    pending()
    render(<Harness />)

    const post = send({ type: 'push-status', id: 10 })
    navigate()
    announce('app-2')

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-status-result', id: 10, ok: false, reason: 'forbidden' },
        '*'
      )
    })
    expect(checks).toEqual([])
  })

  it('still serves a request whose frame survived the wait', async () => {
    // The frame check must not refuse the ordinary first-render case it exists
    // to protect: same frame throughout, id arrives late.
    const requestPermission = vi.spyOn(push, 'requestPermission').mockResolvedValue('denied')
    pending()
    render(<Harness />)

    const post = send({ type: 'push-status', id: 11 })
    announce('app-1')

    await waitFor(() => {
      expect(checks).toEqual([{ app: 'app-1', permission: 'notifications/write' }])
    })
    expect(post).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'forbidden' }),
      '*'
    )
    expect(requestPermission).not.toHaveBeenCalled()
  })
})
