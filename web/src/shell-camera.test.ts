// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// public/shell.js runs in the top-level shell window, outside the React tree
// and outside the bundler, so it is loaded here as source and evaluated
// against a jsdom document shaped like the real shell page — the same harness
// shell-webauthn.test.ts uses.
const SHELL = readFileSync(resolve(__dirname, '../public/shell.js'), 'utf8')

let lastConsentHandler: EventListener | null = null

type Options = {
  granted?: boolean
  // Whether the menu's consent dialog (driven by the shell event) allows.
  consent?: boolean
}

function boot(options: Options = {}) {
  const granted = options.granted ?? false

  document.body.innerHTML =
    '<div id="app-container"></div><div id="menu"></div><div id="shell-progress"></div>'
  window.history.replaceState({}, '', '/someapp/')

  const checks: { app: string | null; permission: string | null }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { body?: string }) => {
      if (String(url).indexOf('/menu/-/permissions/check') >= 0) {
        const body = new URLSearchParams(init?.body ?? '')
        checks.push({ app: body.get('app'), permission: body.get('permission') })
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { granted } }),
        })
      }
      if (String(url).indexOf('/_/token') >= 0) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ app: 'app-entity-id', token: 'menu-token' }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) })
    })
  )

  // The menu's consent dialog, reduced to its event contract. One handler at
  // a time: the window persists across tests in this file, and a previous
  // boot's deny-handler would otherwise answer the next test's dialog first.
  if (lastConsentHandler) window.removeEventListener('mochi-shell-permission-request', lastConsentHandler)
  const consents: string[] = []
  const consentHandler = ((e: Event) => {
    const detail = (e as CustomEvent).detail
    consents.push(detail.permission)
    window.dispatchEvent(
      new CustomEvent('mochi-shell-permission-result', {
        detail: { id: detail.id, result: options.consent ? 'granted' : 'denied' },
      })
    )
  }) as EventListener
  lastConsentHandler = consentHandler
  window.addEventListener('mochi-shell-permission-request', consentHandler)

  // Camera hardware, reduced to its contract.
  const track = { kind: 'video', stop: vi.fn(), onended: null as null | (() => void) }
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  }
  const gum = vi.fn(() => Promise.resolve(stream))
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: gum,
      enumerateDevices: () =>
        Promise.resolve([
          { kind: 'videoinput', deviceId: 'cam1', label: 'Front' },
          { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
        ]),
    },
  })
  const bitmaps: { close: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => {
      const bitmap = { close: vi.fn() }
      bitmaps.push(bitmap)
      return Promise.resolve(bitmap)
    })
  )
  // jsdom's media element implements neither playback nor srcObject.
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get: () => null,
    set: () => {},
  })
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    get: () => 4,
  })

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

  const start = async () => {
    send({ type: 'ready' })
    await settle()
    posted.length = 0
  }

  return { send, posted, checks, consents, gum, track, bitmaps, settle, start }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const resultOf = (posted: Record<string, unknown>[]) => posted.find((m) => m.type === 'camera.result')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('shell camera bridge', () => {
  it('refuses without the camera grant and without consent', async () => {
    const shell = await (async () => {
      const s = boot({ granted: false, consent: false })
      await s.start()
      return s
    })()
    shell.send({ type: 'camera.start', requestId: 7 })
    await shell.settle()
    const result = resultOf(shell.posted) as Record<string, unknown>
    expect(result).toBeTruthy()
    expect(result.ok).toBe(false)
    expect((result.error as { name: string }).name).toBe('NotAllowedError')
    expect(shell.gum).not.toHaveBeenCalled()
    // The grant was checked for the camera permission, against the
    // server-resolved app id — and the consent dialog was offered.
    expect(shell.checks.some((c) => c.permission === 'camera' && c.app === 'app-entity-id')).toBe(true)
    expect(shell.consents).toContain('camera')
  })

  it('opens the camera when the consent dialog allows, and streams frames', async () => {
    const shell = boot({ granted: false, consent: true })
    await shell.start()
    shell.send({ type: 'camera.start', requestId: 8 })
    await shell.settle()
    const result = resultOf(shell.posted) as Record<string, unknown>
    expect(result).toBeTruthy()
    expect(result.ok).toBe(true)
    expect(result.devices).toEqual([{ id: 'cam1', label: 'Front' }])
    expect(shell.gum).toHaveBeenCalled()
    await sleep(120) // the pump's no-rVFC fallback runs at ~33 ms
    const frames = shell.posted.filter((m) => m.type === 'camera.frame')
    expect(frames.length).toBeGreaterThan(0)
    shell.send({ type: 'camera.stop', requestId: 8 })
    await shell.settle()
    expect(shell.track.stop).toHaveBeenCalled()
    expect(shell.posted.some((m) => m.type === 'camera.end')).toBe(true)
  })

  it('skips the dialog when the grant already exists', async () => {
    const shell = boot({ granted: true, consent: false })
    await shell.start()
    shell.send({ type: 'camera.start', requestId: 9 })
    await shell.settle()
    const result = resultOf(shell.posted) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(shell.consents).toHaveLength(0)
  })

  it('aborts the stream when the tab hides — the light must not stay lit', async () => {
    const shell = boot({ granted: true })
    await shell.start()
    shell.send({ type: 'camera.start', requestId: 10 })
    await shell.settle()
    expect((resultOf(shell.posted) as Record<string, unknown>).ok).toBe(true)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    await shell.settle()
    expect(shell.track.stop).toHaveBeenCalled()
    const end = shell.posted.find((m) => m.type === 'camera.end') as Record<string, unknown>
    expect(end.reason).toBe('aborted')
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  it('reports probe support', async () => {
    const shell = boot({})
    await shell.start()
    shell.send({ type: 'camera.probe', requestId: 11 })
    await shell.settle()
    const probe = shell.posted.find((m) => m.type === 'camera.probe.result') as Record<string, unknown>
    expect(probe.supported).toBe(true)
  })
})
