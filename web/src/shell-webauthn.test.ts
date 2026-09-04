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
// against a jsdom document shaped like the real shell page.
const SHELL = readFileSync(resolve(__dirname, '../public/shell.js'), 'utf8')

const OPTIONS = { challenge: 'Y2hhbGxlbmdl', rpId: 'localhost' }
const PERMISSION = 'user/authentication/sign'

type Options = {
  // Grant answer for user/authentication/sign, or 'error' to fail the check.
  granted?: boolean | 'error'
  // Server-resolved app id; absent models a navigation still in flight.
  app?: string | null
}

// boot mounts the shell and returns handles for driving it: a way to send the
// messages a hostile app could send, the messages the iframe received back, a
// count of the ceremonies that actually reached navigator.credentials, and the
// permission checks the shell made.
function boot(options: Options = {}) {
  const granted = options.granted ?? false
  const app = options.app === undefined ? 'app-entity-id' : options.app

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
        if (granted === 'error') return Promise.reject(new Error('network down'))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { granted } }),
        })
      }
      // The shell learns the app id from /_/token, not from any message; an
      // answer without one models a navigation still in flight.
      if (String(url).indexOf('/_/token') >= 0) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(app ? { app, token: 'menu-token' } : {}),
        })
      }
      // /_/shell: shape enough to not reject.
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) })
    })
  )

  const ceremonies = { create: 0, get: 0 }
  vi.stubGlobal('PublicKeyCredential', {
    parseCreationOptionsFromJSON: (o: unknown) => o,
    parseRequestOptionsFromJSON: (o: unknown) => o,
  })
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      create: () => {
        ceremonies.create++
        return Promise.resolve({ toJSON: () => ({ id: 'signed' }) })
      },
      get: () => {
        ceremonies.get++
        return Promise.resolve({ toJSON: () => ({ id: 'signed' }) })
      },
    },
  })

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

  // "ready" is what makes the shell fetch the token, which is the only thing
  // that resolves the app id it later checks the grant against.
  const start = async () => {
    send({ type: 'ready' })
    await settle()
    posted.length = 0
  }

  return { send, posted, ceremonies, checks, settle, start }
}

const resultOf = (posted: Record<string, unknown>[], create: boolean) =>
  posted.find(
    (m) => m.type === (create ? 'webauthn.create.result' : 'webauthn.get.result')
  )

// The bridge takes the user's grant whichever app asks; no app is privileged by
// name.
describe('shell WebAuthn bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('refuses a get ceremony when the grant is absent', async () => {
    const shell = boot({ granted: false })
    await shell.start()
    shell.send({ type: 'webauthn.get', requestId: 7, optionsJSON: OPTIONS })
    await shell.settle()

    const result = resultOf(shell.posted, false)
    expect(result?.requestId).toBe(7)
    expect(result?.error).toMatchObject({ name: 'SecurityError' })
    expect(result?.credential).toBeUndefined()
    // The point of the gate: the user is never shown a prompt to answer.
    expect(shell.ceremonies.get).toBe(0)
  })

  it('refuses a create ceremony when the grant is absent', async () => {
    const shell = boot({ granted: false })
    await shell.start()
    shell.send({ type: 'webauthn.create', requestId: 8, optionsJSON: OPTIONS })
    await shell.settle()

    expect(resultOf(shell.posted, true)?.error).toMatchObject({ name: 'SecurityError' })
    expect(shell.ceremonies.create).toBe(0)
  })

  it('allows a get ceremony once the user has granted it', async () => {
    const shell = boot({ granted: true })
    await shell.start()
    shell.send({ type: 'webauthn.get', requestId: 9, optionsJSON: OPTIONS })
    await shell.settle()

    const result = resultOf(shell.posted, false)
    expect(result?.error).toBeUndefined()
    expect(result?.credential).toEqual({ id: 'signed' })
    expect(shell.ceremonies.get).toBe(1)
  })

  it('allows a create ceremony once the user has granted it', async () => {
    const shell = boot({ granted: true })
    await shell.start()
    shell.send({ type: 'webauthn.create', requestId: 10, optionsJSON: OPTIONS })
    await shell.settle()

    expect(resultOf(shell.posted, true)?.credential).toEqual({ id: 'signed' })
    expect(shell.ceremonies.create).toBe(1)
  })

  it('checks the grant against the server-resolved app id', async () => {
    const shell = boot({ granted: true, app: 'the-real-entity' })
    await shell.start()
    shell.send({ type: 'webauthn.get', requestId: 11, optionsJSON: OPTIONS })
    await shell.settle()

    expect(shell.checks).toContainEqual({
      app: 'the-real-entity',
      permission: PERMISSION,
    })
  })

  // Everything below is the fail-closed side: a refusal that depends on a
  // network answer must not become an approval when the answer never arrives.
  it('refuses while the app id is still unresolved', async () => {
    const shell = boot({ granted: true, app: null })
    await shell.start()
    shell.send({ type: 'webauthn.get', requestId: 12, optionsJSON: OPTIONS })
    await shell.settle()

    expect(resultOf(shell.posted, false)?.error).toMatchObject({ name: 'SecurityError' })
    expect(shell.ceremonies.get).toBe(0)
    // No app to ask about, so it must not even reach the server.
    expect(shell.checks).toHaveLength(0)
  })

  it('refuses when the permission check itself fails', async () => {
    const shell = boot({ granted: 'error' })
    await shell.start()
    shell.send({ type: 'webauthn.get', requestId: 13, optionsJSON: OPTIONS })
    await shell.settle()

    expect(resultOf(shell.posted, false)?.error).toMatchObject({ name: 'SecurityError' })
    expect(shell.ceremonies.get).toBe(0)
  })

  // The grant is resolved from the shell's own state, so naming a permitted app
  // in the message buys nothing.
  it('ignores an app id asserted by the caller', async () => {
    const shell = boot({ granted: false, app: 'the-real-entity' })
    await shell.start()
    shell.send({
      type: 'webauthn.get',
      requestId: 14,
      optionsJSON: OPTIONS,
      app: 'settings',
      currentAppEntity: 'settings',
    })
    await shell.settle()

    expect(resultOf(shell.posted, false)?.error).toMatchObject({ name: 'SecurityError' })
    expect(shell.ceremonies.get).toBe(0)
    for (const check of shell.checks) expect(check.app).toBe('the-real-entity')
  })
})

// shell.js has no catalog: a bridge error is a DOMException-style name, and
// lib/web maps it to a translated message. English prose here used to reach
// the settings app's toast verbatim.
describe('shell bridge errors carry a name only', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('posts the passkey refusal without a message', async () => {
    const shell = boot({ granted: false })
    await shell.start()
    shell.send({ type: 'webauthn.get', requestId: 11, optionsJSON: OPTIONS })
    await shell.settle()
    expect(resultOf(shell.posted, false)?.error).toEqual({ name: 'SecurityError' })
  })
})
