// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Shared helpers for calling the menu app's own backend. The shell chrome runs
// in the top window, so it fetches /menu/-/... directly with the session cookie
// plus the menu's bearer token.

import { useAuthStore } from '@mochi/web'

const MENU_PATH = '/menu'

function getMenuToken(): string {
  return useAuthStore.getState().token || ''
}

/**
 * A refused menu request, carrying what the server said rather than only that
 * it refused.
 *
 * Both error paths answer with the Mochi envelope — `{error: <code>, message:
 * <text in the user's language>}` from respond_error and a.error.label — and
 * `data` hands that to normalizeError in @mochi/web, which prefers the
 * localized `message` for display and keeps `error` as a code callers can
 * switch on. Throwing a bare Error instead put a hardcoded English string
 * where normalizeError looks FIRST, so it outranked both the server's
 * translation and the caller's own translated fallback.
 *
 * When the server says nothing usable — a proxy's HTML 502, an empty body —
 * the message is left EMPTY on purpose. normalizeError skips an empty
 * error.message and reaches the caller's own translated fallback, which is the
 * best text available; a technical `Menu API error: 502` in its place would
 * simply be untranslated English shown to every user. The status stays on the
 * error, and the DEV log above already carries the method, path and body, so
 * nothing diagnostic is lost.
 */
export class MenuApiError extends Error {
  readonly status: number
  readonly data: unknown
  readonly code?: string

  constructor(status: number, data: unknown, message: string, code?: string) {
    super(message)
    this.name = 'MenuApiError'
    this.status = status
    this.data = data
    this.code = code
  }
}

// Pull the envelope out of an error body. Anything that is not JSON with a
// usable message — a proxy's HTML 502, an empty body — yields nothing, and the
// caller falls back to the status.
function parseErrorBody(body: string): { data?: unknown; message?: string; code?: string } {
  if (!body) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const envelope = parsed as { error?: unknown; message?: unknown }
  const message = typeof envelope.message === 'string' && envelope.message ? envelope.message : undefined
  const code = typeof envelope.error === 'string' && envelope.error ? envelope.error : undefined
  return { data: parsed, message, code }
}

export async function menuFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getMenuToken()
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log(`[menu-fetch] ${init?.method || 'GET'} ${path} token=${token ? 'present' : 'NONE'}`)
  }
  const res = await fetch(`${MENU_PATH}/${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...init?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error(`[menu-fetch] ${init?.method || 'GET'} ${path} -> ${res.status} ${body}`)
    }
    const { data, message, code } = parseErrorBody(body)
    throw new MenuApiError(res.status, data, message ?? '', code)
  }
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log(`[menu-fetch] ${init?.method || 'GET'} ${path} -> ${res.status}`)
  }
  return res.json()
}
