// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'

// The fetch bridge: the shell makes an app frame's requests, from the server's
// own origin, so they need no CORS preflight. Loaded as source, as in
// shell-navigate.test.ts.
const SHELL = readFileSync(resolve(__dirname, '../public/shell.js'), 'utf8')

type Call = { url: string; init: RequestInit & { headers: Headers } }

// boot mounts the shell on /feeds/. App requests reach `respond`, which a test
// may hold open; the token mint answers at once.
function boot(respond?: (call: Call) => Promise<unknown>) {
  document.body.innerHTML =
    '<div id="app-container"></div><div id="menu"></div><div id="shell-progress"></div>'
  window.history.replaceState({}, '', '/feeds/')

  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const target = String(url)
      // The bridge's own requests, whatever their URL: only it fetches with
      // redirects left unfollowed. Recording by URL instead missed exactly
      // the requests the refusal tests are about.
      if (init?.redirect === 'manual') {
        const call = { url: target, init: init as Call['init'] }
        calls.push(call)
        if (respond) return respond(call)
        return Promise.resolve(
          new Response('{"data":1}', {
            status: 201,
            statusText: 'Created',
            headers: { 'Content-Type': 'application/json' },
          })
        )
      }
      if (target.indexOf('/_/token') >= 0) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ app: 'entity', token: 'app-token' }),
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
  const posted: Array<{ message: Record<string, unknown>; transfer: unknown }> =
    []
  const source = iframe.contentWindow as Window
  source.postMessage = ((
    message: Record<string, unknown>,
    _origin: string,
    transfer?: unknown
  ) => {
    posted.push({ message, transfer })
  }) as typeof source.postMessage

  const send = (data: Record<string, unknown>, from: Window = source) => {
    const event = new MessageEvent('message', { data })
    Object.defineProperty(event, 'source', { value: from })
    window.dispatchEvent(event)
  }
  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }
  const results = () =>
    posted
      .filter((p) => p.message.type === 'fetch.result')
      .map((p) => p.message)

  return { send, settle, calls, posted, results, iframe }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
})

describe('shell fetch: carries the frame’s requests in its own app', () => {
  it('fetches with the frame’s headers, no cookies, and no redirects', async () => {
    const shell = boot()
    shell.send({
      type: 'fetch',
      id: 7,
      url: 'http://localhost:3000/feeds/-/save',
      method: 'post',
      headers: [
        ['Authorization', 'Bearer app-token'],
        ['Content-Type', 'application/json'],
      ],
      body: '{"name":"x"}',
    })
    await shell.settle()

    expect(shell.calls).toHaveLength(1)
    const { url, init } = shell.calls[0]
    expect(url).toBe('http://localhost:3000/feeds/-/save')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('manual')
    expect(init.headers.get('Authorization')).toBe('Bearer app-token')
    expect(init.body).toBe('{"name":"x"}')

    const [result] = shell.results()
    expect(result).toMatchObject({
      type: 'fetch.result',
      id: 7,
      status: 201,
      statusText: 'Created',
    })
    expect(result.headers).toContainEqual(['content-type', 'application/json'])
    expect(new TextDecoder().decode(result.body as ArrayBuffer)).toBe(
      '{"data":1}'
    )
    // The body is handed over, not copied.
    const sent = shell.posted.find((p) => p.message === result)
    expect(sent?.transfer).toEqual([result.body])
  })

  it('rebuilds a form from its entries and lets the browser type it', async () => {
    const shell = boot()
    shell.send({
      type: 'fetch',
      id: 1,
      url: '/feeds/-/upload',
      method: 'POST',
      headers: [['Content-Type', 'multipart/form-data']],
      body: {
        form: [
          ['title', 'Hello'],
          ['file', new File(['bytes'], 'notes.txt')],
        ],
      },
    })
    await shell.settle()

    const { init } = shell.calls[0]
    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('title')).toBe('Hello')
    expect((form.get('file') as File).name).toBe('notes.txt')
    expect(init.headers.get('Content-Type')).toBeNull()
  })

  it('sends no body on a read', async () => {
    const shell = boot()
    shell.send({
      type: 'fetch',
      id: 1,
      url: '/feeds/-/list',
      method: 'GET',
      headers: [],
      body: 'stray',
    })
    await shell.settle()
    expect(shell.calls[0].init.body).toBeUndefined()
  })

  it('answers a redirect without following it', async () => {
    const shell = boot(() =>
      Promise.resolve({ type: 'opaqueredirect', status: 0 })
    )
    shell.send({
      type: 'fetch',
      id: 2,
      url: '/feeds/-/go',
      method: 'GET',
      headers: [],
    })
    await shell.settle()
    expect(shell.results()).toEqual([
      { type: 'fetch.result', id: 2, redirect: true },
    ])
  })

  it('answers a failed fetch', async () => {
    const shell = boot(() => Promise.reject(new TypeError('Failed to fetch')))
    shell.send({
      type: 'fetch',
      id: 3,
      url: '/feeds/-/list',
      method: 'GET',
      headers: [],
    })
    await shell.settle()
    expect(shell.results()).toEqual([
      { type: 'fetch.result', id: 3, failed: true },
    ])
  })
})

// Off-origin forms, and on-origin ones in another app: an origin check alone
// passes the second group.
const REFUSED_URLS = [
  ['absolute', 'https://evil.example/feeds/-/list'],
  ['protocol-relative', '//evil.example/feeds/-/list'],
  ['core route', '/_/token'],
  ['another app', '/settings/-/list'],
  ['traversal', '/feeds/../settings/-/list'],
  ['encoded traversal', '/feeds/%2e%2e/settings/-/list'],
  ['absolute same-origin', 'http://localhost:3000/settings/-/list'],
  ['root', '/'],
]

describe('shell fetch: refuses anything else, so the frame goes direct', () => {
  it.each(REFUSED_URLS)('refuses %s', async (_name, url) => {
    const shell = boot()
    shell.send({ type: 'fetch', id: 4, url, method: 'GET', headers: [] })
    await shell.settle()
    expect(shell.calls).toHaveLength(0)
    expect(shell.results()).toEqual([
      { type: 'fetch.result', id: 4, refused: true },
    ])
  })

  it.each([['OPTIONS'], ['CONNECT'], ['TRACE'], ['']])(
    'refuses the method %s',
    async (method) => {
      const shell = boot()
      shell.send({
        type: 'fetch',
        id: 5,
        url: '/feeds/-/list',
        method,
        headers: [],
      })
      await shell.settle()
      expect(shell.calls).toHaveLength(0)
      expect(shell.results()).toEqual([
        { type: 'fetch.result', id: 5, refused: true },
      ])
    }
  )

  it('refuses headers or a body it cannot carry', async () => {
    const shell = boot()
    shell.send({
      type: 'fetch',
      id: 6,
      url: '/feeds/-/list',
      method: 'POST',
      headers: [['only-a-name']],
    })
    shell.send({
      type: 'fetch',
      id: 8,
      url: '/feeds/-/list',
      method: 'POST',
      headers: [],
      body: { unknown: true },
    })
    await shell.settle()
    expect(shell.calls).toHaveLength(0)
    expect(shell.results()).toEqual([
      { type: 'fetch.result', id: 6, refused: true },
      { type: 'fetch.result', id: 8, refused: true },
    ])
  })

  it('ignores a request from any window but its frame', async () => {
    const shell = boot()
    shell.send(
      {
        type: 'fetch',
        id: 9,
        url: '/feeds/-/list',
        method: 'GET',
        headers: [],
      },
      window
    )
    await shell.settle()
    expect(shell.calls).toHaveLength(0)
    expect(shell.results()).toEqual([])
  })
})

describe('shell fetch: ends with the frame’s say-so', () => {
  it('aborts a request the frame abandons', async () => {
    const shell = boot(() => new Promise(() => {}))
    shell.send({
      type: 'fetch',
      id: 10,
      url: '/feeds/-/slow',
      method: 'GET',
      headers: [],
    })
    await shell.settle()
    const signal = shell.calls[0].init.signal as AbortSignal
    expect(signal.aborted).toBe(false)

    shell.send({ type: 'fetch.abort', id: 11 })
    expect(signal.aborted).toBe(false)
    shell.send({ type: 'fetch.abort', id: 10 })
    expect(signal.aborted).toBe(true)
  })

  it('aborts a frame’s requests when the frame is removed', async () => {
    const shell = boot(() => new Promise(() => {}))
    shell.send({
      type: 'fetch',
      id: 12,
      url: '/feeds/-/slow',
      method: 'GET',
      headers: [],
    })
    await shell.settle()
    const signal = shell.calls[0].init.signal as AbortSignal

    // Crossing apps mounts a new frame; the old one stays on screen until the
    // new one is ready, and so do its requests, as its own would.
    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()
    const next = document.getElementById('app-frame') as HTMLIFrameElement
    expect(next).not.toBe(shell.iframe)
    expect(signal.aborted).toBe(false)

    const fresh = next.contentWindow as Window
    fresh.postMessage = (() => {}) as typeof fresh.postMessage
    shell.send({ type: 'ready' }, fresh)
    await shell.settle()
    expect(signal.aborted).toBe(true)
  })

  it('answers only the frame that asked', async () => {
    let release: (value: unknown) => void = () => {}
    const shell = boot(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    shell.send({
      type: 'fetch',
      id: 13,
      url: '/feeds/-/slow',
      method: 'GET',
      headers: [],
    })
    await shell.settle()

    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()
    const next = document.getElementById('app-frame') as HTMLIFrameElement
    const answered: Array<Record<string, unknown>> = []
    const fresh = next.contentWindow as Window
    fresh.postMessage = ((message: Record<string, unknown>) => {
      answered.push(message)
    }) as typeof fresh.postMessage

    // The feeds frame's answer lands after the settings frame replaced it:
    // it goes to the feeds frame, never the one now on screen.
    release(new Response('{"data":"feeds"}', { status: 200 }))
    await shell.settle()
    expect(answered.filter((m) => m.type === 'fetch.result')).toEqual([])
    expect(shell.results()).toMatchObject([{ id: 13, status: 200 }])
  })

  // Crossing apps keeps the outgoing frame on screen until the next is ready,
  // and its page may still be saving as it goes. Its requests used to be
  // dropped unsent - only the new frame was heard - and the page waited for
  // ever on the answer.
  async function crossed(respond?: (call: Call) => Promise<unknown>) {
    const shell = boot(respond)
    shell.send({ type: 'navigate-external', url: '/settings/' })
    await shell.settle()
    const next = document.getElementById('app-frame') as HTMLIFrameElement
    expect(next).not.toBe(shell.iframe)
    return { shell, next }
  }

  it('carries the outgoing frame’s requests during a switch', async () => {
    const { shell } = await crossed()
    shell.send({
      type: 'fetch',
      id: 16,
      url: '/feeds/-/save',
      method: 'POST',
      headers: [],
      body: 'unsaved',
    })
    await shell.settle()

    expect(shell.calls.map((call) => call.url)).toEqual([
      'http://localhost:3000/feeds/-/save',
    ])
    expect(shell.results()).toMatchObject([{ id: 16, status: 201 }])
  })

  it('holds the outgoing frame to its own app, not the one replacing it', async () => {
    const { shell } = await crossed()
    shell.send({
      type: 'fetch',
      id: 17,
      url: '/settings/-/list',
      method: 'GET',
      headers: [],
    })
    await shell.settle()

    expect(shell.calls).toHaveLength(0)
    expect(shell.results()).toEqual([
      { type: 'fetch.result', id: 17, refused: true },
    ])
  })

  it('ends the outgoing frame’s requests when it is removed', async () => {
    const { shell, next } = await crossed(() => new Promise(() => {}))
    shell.send({
      type: 'fetch',
      id: 18,
      url: '/feeds/-/slow',
      method: 'GET',
      headers: [],
    })
    await shell.settle()
    const signal = shell.calls[0].init.signal as AbortSignal

    shell.send({ type: 'fetch.abort', id: 99 })
    expect(signal.aborted).toBe(false)

    const fresh = next.contentWindow as Window
    fresh.postMessage = (() => {}) as typeof fresh.postMessage
    shell.send({ type: 'ready' }, fresh)
    await shell.settle()
    expect(signal.aborted).toBe(true)
  })

  it('lets the outgoing frame cancel its own request', async () => {
    const { shell } = await crossed(() => new Promise(() => {}))
    shell.send({
      type: 'fetch',
      id: 19,
      url: '/feeds/-/slow',
      method: 'GET',
      headers: [],
    })
    await shell.settle()
    const signal = shell.calls[0].init.signal as AbortSignal

    shell.send({ type: 'fetch.abort', id: 19 })
    expect(signal.aborted).toBe(true)
  })

  // A frame that navigates itself stays the same window, so answers to the
  // page that left would reach whatever page it loaded next. They end as the
  // page goes: 'leaving' from the page, or, for bundles that send none, the
  // frame loading again.
  it('aborts the requests of a page that leaves', async () => {
    const shell = boot(() => new Promise(() => {}))
    shell.send({
      type: 'fetch',
      id: 14,
      url: '/feeds/-/slow',
      method: 'GET',
      headers: [],
    })
    await shell.settle()
    const signal = shell.calls[0].init.signal as AbortSignal

    shell.send({ type: 'leaving' })
    expect(signal.aborted).toBe(true)
  })

  it('aborts them when the frame loads another page', async () => {
    const shell = boot(() => new Promise(() => {}))
    // The frame's own first page.
    shell.iframe.dispatchEvent(new Event('load'))
    shell.send({
      type: 'fetch',
      id: 15,
      url: '/feeds/-/slow',
      method: 'GET',
      headers: [],
    })
    await shell.settle()
    const signal = shell.calls[0].init.signal as AbortSignal
    expect(signal.aborted).toBe(false)

    shell.iframe.dispatchEvent(new Event('load'))
    expect(signal.aborted).toBe(true)
  })

  it('tells the frame the bridge is there', async () => {
    const shell = boot()
    shell.send({ type: 'ready' })
    await shell.settle()
    const init = shell.posted.find((p) => p.message.type === 'init')
    expect(init?.message.fetch).toBe(true)
  })
})
