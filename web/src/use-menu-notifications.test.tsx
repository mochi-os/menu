// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { toast } from '@mochi/web'
import type { ReactNode } from 'react'
import { menuFetch } from './menu-api'
import { useMenuNotifications } from './use-menu-notifications'

i18n.loadAndActivate({ locale: 'en', messages: {} })

vi.mock('@mochi/web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mochi/web')>()
  return { ...actual, toast: { ...actual.toast, error: vi.fn(), success: vi.fn() } }
})
vi.mock('./menu-api', () => ({ menuFetch: vi.fn() }))

// The hook opens the notifications socket on mount; none of that is under
// test, and a real WebSocket would try to connect.
class SilentSocket {
  static OPEN = 1
  static CONNECTING = 0
  readyState = 3
  onmessage: unknown = null
  onclose: unknown = null
  onerror: unknown = null
  close() {}
}

const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
})

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nProvider>
  )
}

beforeEach(() => {
  client.clear()
  vi.stubGlobal('WebSocket', SilentSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ token: 'socket-token' }) }))
  )
  vi.mocked(toast.error).mockReset()
  // The list loads; every read is refused.
  vi.mocked(menuFetch).mockReset()
  vi.mocked(menuFetch).mockImplementation(async (path: string) => {
    if (path === '-/notifications/list') return { data: [] }
    throw new Error('refused by the server')
  })
})

afterEach(() => vi.unstubAllGlobals())

// A refused read leaves the badge as it was; silent, the click looks like it
// did nothing. Same rule the category picker in this app already follows.
describe('useMenuNotifications reports a refused read', () => {
  it('toasts when marking one notification read fails', async () => {
    const { result } = renderHook(() => useMenuNotifications(), { wrapper })
    act(() => result.current.markAsRead('n1'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).not.toBe('')
  })

  it('toasts when marking every notification read fails', async () => {
    const { result } = renderHook(() => useMenuNotifications(), { wrapper })
    act(() => result.current.markAllAsRead())
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
  })
})
