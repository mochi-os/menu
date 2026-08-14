// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getErrorMessage, useAuthStore } from '@mochi/web'
import { menuFetch, MenuApiError } from './menu-api'

// What the caller actually shows the user. The menu's own call sites do
// `toast.error(getErrorMessage(error, t`...`))`, so asserting on this is
// asserting on the toast — a test against the thrown Error's own .message
// would miss that normalizeError prefers a payload message over it.
const shown = (error: unknown, fallback: string) => getErrorMessage(error, fallback)

const FALLBACK = 'Failed to load notification categories'

// Returns the rejection, and fails loudly if the call resolved instead — an
// `await ... .catch(e => e)` would quietly hand a success value to assertions
// written for an error.
async function failure(path: string): Promise<MenuApiError> {
  try {
    await menuFetch(path)
  } catch (error) {
    return error as MenuApiError
  }
  throw new Error(`expected menuFetch(${path}) to reject`)
}

function respond(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    }) as Response)
  )
}

beforeEach(() => {
  useAuthStore.setState({ token: 'test-token' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('menuFetch surfaces what the server said', () => {
  it('shows the server\'s localized message, not a status string', async () => {
    // The Mochi envelope from respond_error / a.error.label, already resolved
    // into the request's language by the server.
    respond(403, JSON.stringify({ error: 'restricted_permissions_disabled', message: 'Autorisation restreinte refusée' }))

    const error = await failure('-/permissions/grant')
    expect(error).toBeInstanceOf(MenuApiError)

    expect(shown(error, FALLBACK)).toBe('Autorisation restreinte refusée')
    // Unfixed, this was the hardcoded English that reached the toast — and it
    // beat the caller's translated fallback too, because normalizeError takes
    // error.message before it ever considers the fallback.
    expect(shown(error, FALLBACK)).not.toContain('Menu API error')
    expect(shown(error, FALLBACK)).not.toBe(FALLBACK)
  })

  it('keeps the machine-readable code so callers can branch on it', async () => {
    respond(403, JSON.stringify({ error: 'restricted_permissions_disabled', message: 'Refusé' }))
    const error = await failure('-/permissions/grant')

    expect(error.code).toBe('restricted_permissions_disabled')
    expect(error.status).toBe(403)
  })

  it('falls back to the caller\'s translated string when the body carries no message', async () => {
    // A proxy answering with HTML, or an empty body: there is nothing to show,
    // so the caller's own translated fallback should win rather than a
    // hardcoded English status line.
    respond(502, '<html><head><title>Bad Gateway</title></head></html>')
    const error = await failure('-/permissions/grant')

    expect(error.status).toBe(502)
    expect(error.data).toBeUndefined()
    expect(shown(error, FALLBACK)).toBe(FALLBACK)
  })

  it('falls back on an empty body', async () => {
    respond(500, '')
    const error = await failure('-/permissions/grant')
    expect(shown(error, FALLBACK)).toBe(FALLBACK)
  })

  it('uses the code when the envelope carries no message', async () => {
    // Handlers predating respond_error send only `error`; normalizeError reads
    // it as both code and message rather than dropping to the fallback.
    respond(404, JSON.stringify({ error: 'not_found' }))
    const error = await failure('-/permissions/name')

    expect(shown(error, FALLBACK)).toBe('not_found')
    expect(error.code).toBe('not_found')
  })

  it('returns the parsed body on success', async () => {
    // Companion: the error path is what changed, so prove the success path
    // still hands the caller its data.
    respond(200, JSON.stringify({ data: { granted: true } }))
    await expect(menuFetch('-/permissions/check')).resolves.toEqual({ data: { granted: true } })
  })
})
