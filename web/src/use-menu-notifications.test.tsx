// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { toast } from '@mochi/web'
import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { menuFetch } from './menu-api'
import { notificationsAfter, useMenuNotifications } from './use-menu-notifications'

i18n.loadAndActivate({ locale: 'en', messages: {} })

vi.mock('@mochi/web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mochi/web')>()
  return {
    ...actual,
    toast: { ...actual.toast, error: vi.fn(), success: vi.fn() },
  }
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
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'socket-token' }),
    }))
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

// A notification for the chat or game already on screen has been read by the
// time it arrives: the reader is looking at it. Retiring it here keeps it out
// of the bell and off their other devices. A container must not do the same -
// being on a feed says nothing about its posts.
describe('useMenuNotifications retires what is on screen', () => {
  const row = (id: string, link: string) => ({
    id,
    app: 'chat',
    topic: 'message',
    object: 'o1',
    content: 'Hello',
    link,
    count: 1,
    created: 1,
    read: 0,
  })

  function listing(rows: ReturnType<typeof row>[]) {
    vi.mocked(menuFetch).mockImplementation(async (path: string) => {
      if (path === '-/notifications/list') return { data: rows }
      return {}
    })
  }

  it('marks a notification naming the open page read', async () => {
    window.history.pushState({}, '', '/chat/c1')
    listing([row('n1', '/chat/c1')])
    renderHook(() => useMenuNotifications(), { wrapper })
    await waitFor(() =>
      expect(vi.mocked(menuFetch)).toHaveBeenCalledWith(
        '-/notifications/read',
        expect.objectContaining({ body: 'id=n1' })
      )
    )
  })

  it('leaves a notification about something under the open page alone', async () => {
    window.history.pushState({}, '', '/feeds/f1')
    listing([row('n2', '/feeds/f1/posts/p1')])
    const { result } = renderHook(() => useMenuNotifications(), { wrapper })
    await waitFor(() => expect(result.current.notifications).toHaveLength(1))
    expect(vi.mocked(menuFetch)).not.toHaveBeenCalledWith(
      '-/notifications/read',
      expect.anything()
    )
  })

  it('leaves a notification for another page alone', async () => {
    window.history.pushState({}, '', '/chat/c1')
    listing([row('n3', '/chat/c2')])
    const { result } = renderHook(() => useMenuNotifications(), { wrapper })
    await waitFor(() => expect(result.current.notifications).toHaveLength(1))
    expect(vi.mocked(menuFetch)).not.toHaveBeenCalledWith(
      '-/notifications/read',
      expect.anything()
    )
  })

  it('retires nothing from an app listing with no entity', async () => {
    window.history.pushState({}, '', '/chat')
    listing([row('n4', '/chat')])
    const { result } = renderHook(() => useMenuNotifications(), { wrapper })
    await waitFor(() => expect(result.current.notifications).toHaveLength(1))
    expect(vi.mocked(menuFetch)).not.toHaveBeenCalledWith(
      '-/notifications/read',
      expect.anything()
    )
  })
})

const bell = (id: string, created: number, read = 0) => ({
  id,
  app: 'chat',
  topic: 'message',
  object: 'o1',
  content: `Message ${id}`,
  link: `/chat/${id}`,
  sender: 'sender-entity',
  count: 1,
  created,
  read,
})

// A frame lands in the list the bell holds, as a fetch would answer it: oldest
// first, a row sent again replacing the one held, a row the bell does not list
// left out. A frame that cannot be applied asks for the list again.
describe('notificationsAfter', () => {
  const held = [bell('a', 10), bell('c', 30)]

  it('puts a new row where its time puts it, with its sender', () => {
    const next = notificationsAfter(held, { type: 'new', web: true, ...bell('b', 20) })
    expect(next?.map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(next?.[1].sender).toBe('sender-entity')
  })

  it('replaces a row sent again rather than listing it twice', () => {
    const next = notificationsAfter(held, { type: 'new', web: true, ...bell('a', 10), count: 3 })
    expect(next?.map((row) => [row.id, row.count])).toEqual([['a', 3], ['c', 1]])
  })

  it('leaves out a row the bell does not list', () => {
    expect(notificationsAfter(held, { type: 'new', web: false, ...bell('b', 20) })).toBe(held)
    expect(notificationsAfter(held, { type: 'new', web: false, ...bell('a', 10) })?.map((row) => row.id)).toEqual(['c'])
  })

  it('asks for the list when the frame cannot say whether the bell lists it', () => {
    expect(notificationsAfter(held, { type: 'new', ...bell('b', 20) })).toBeNull()
  })

  it('marks one row, then every row, read', () => {
    const one = notificationsAfter(held, { type: 'read', id: 'c' })
    expect(one?.map((row) => Boolean(row.read))).toEqual([false, true])
    const every = notificationsAfter(held, { type: 'read_all' })
    expect(every?.every((row) => row.read > 0)).toBe(true)
  })

  it('asks for the list on a clear, which names no rows', () => {
    expect(notificationsAfter(held, { type: 'clear_object' })).toBeNull()
  })
})

// The socket the hook opens, captured so a test can deliver frames to it.
class FrameSocket {
  static OPEN = 1
  static CONNECTING = 0
  static last: FrameSocket | null = null
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FrameSocket.last = this
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  send(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  close() {}
}

// THE POINT: every frame - a new notification, a read, a read of every row -
// downloaded the whole list again in every open tab. They are applied to the
// list held; only a frame that cannot be applied, and a reconnect, which lost
// the frames sent meanwhile, fetch it.
describe('useMenuNotifications applies frames to the list it holds', () => {
  beforeEach(() => {
    FrameSocket.last = null
    vi.stubGlobal('WebSocket', FrameSocket)
    vi.mocked(menuFetch).mockImplementation(async (path: string) => {
      if (path === '-/notifications/list') return { data: [bell('a', 10)] }
      return {}
    })
  })

  const fetches = () =>
    vi.mocked(menuFetch).mock.calls.filter(([path]) => path === '-/notifications/list').length

  async function mounted() {
    window.history.pushState({}, '', '/feeds')
    const hook = renderHook(() => useMenuNotifications(), { wrapper })
    await waitFor(() => expect(hook.result.current.notifications).toHaveLength(1))
    await waitFor(() => expect(FrameSocket.last).not.toBeNull())
    const opened = fetches()
    act(() => FrameSocket.last!.open())
    // The open reads the list again, for frames sent before it.
    await waitFor(() => expect(fetches()).toBe(opened + 1))
    await waitFor(() =>
      expect(client.getQueryState(['menu-notifications', 'list'])?.fetchStatus).toBe('idle')
    )
    return hook
  }

  it('adds a new notification, marks reads, and fetches nothing', async () => {
    const { result } = await mounted()
    const before = fetches()
    act(() => FrameSocket.last!.send({ type: 'new', web: true, ...bell('b', 20) }))
    await waitFor(() => expect(result.current.notifications.map((row) => row.id)).toEqual(['a', 'b']))
    act(() => FrameSocket.last!.send({ type: 'read', id: 'a' }))
    await waitFor(() => expect(result.current.notifications[0].read).toBeGreaterThan(0))
    act(() => FrameSocket.last!.send({ type: 'read_all' }))
    await waitFor(() => expect(result.current.notifications.every((row) => row.read > 0)).toBe(true))
    expect(fetches()).toBe(before)
  })

  it('fetches the list for a frame from an older notifications app, a clear, a category change, and a reconnect', async () => {
    await mounted()
    const before = fetches()
    act(() => FrameSocket.last!.send({ type: 'new', ...bell('b', 20) }))
    await waitFor(() => expect(fetches()).toBe(before + 1))
    act(() => FrameSocket.last!.send({ type: 'clear_object', app: 'chat', object: 'o1' }))
    await waitFor(() => expect(fetches()).toBe(before + 2))
    act(() => FrameSocket.last!.send({ type: 'clear_object', app: 'chat', object: 'o1', changed: 2 }))
    await waitFor(() => expect(fetches()).toBe(before + 3))
    act(() => FrameSocket.last!.send({ type: 'categories' }))
    await waitFor(() => expect(fetches()).toBe(before + 4))
    act(() => FrameSocket.last!.open())
    await waitFor(() => expect(fetches()).toBe(before + 5))
  })

  it('fetches nothing for a clear that changed no row', async () => {
    const { result } = await mounted()
    const before = fetches()
    act(() => FrameSocket.last!.send({ type: 'clear_object', app: 'chat', object: 'o1', changed: 0 }))
    act(() => FrameSocket.last!.send({ type: 'new', web: true, ...bell('b', 20) }))
    await waitFor(() => expect(result.current.notifications).toHaveLength(2))
    expect(fetches()).toBe(before)
  })

  it('fetches again for a frame arriving while the list is being fetched', async () => {
    const { result } = await mounted()
    const start = fetches()
    let land: (value: unknown) => void = () => {}
    vi.mocked(menuFetch).mockImplementation(async (path: string) => {
      if (path !== '-/notifications/list') return {}
      // The first fetch answers from before the frame, the second after it.
      if (fetches() === start + 1) {
        await new Promise((resolve) => (land = resolve))
        return { data: [bell('a', 10)] }
      }
      return { data: [bell('a', 10), bell('b', 20)] }
    })
    act(() => {
      void client.refetchQueries({ queryKey: ['menu-notifications', 'list'] })
    })
    await waitFor(() => expect(fetches()).toBe(start + 1))
    act(() => FrameSocket.last!.send({ type: 'new', web: true, ...bell('b', 20) }))
    act(() => land(undefined))
    await waitFor(() =>
      expect(result.current.notifications.map((row) => row.id)).toEqual(['a', 'b'])
    )
    expect(fetches()).toBe(start + 2)
  })

  it('leaves unread a notification that arrives while marking all read is answered', async () => {
    const { result } = await mounted()
    let answer: (value: unknown) => void = () => {}
    vi.mocked(menuFetch).mockImplementation(async (path: string) => {
      if (path === '-/notifications/list') return { data: [bell('a', 10)] }
      await new Promise((resolve) => (answer = resolve))
      return {}
    })
    act(() => result.current.markAllAsRead())
    await waitFor(() => expect(result.current.notifications[0].read).toBeGreaterThan(0))
    // The server marks all read, then b arrives, then the answer lands.
    act(() => FrameSocket.last!.send({ type: 'read_all' }))
    act(() => FrameSocket.last!.send({ type: 'new', web: true, ...bell('b', 20) }))
    await waitFor(() => expect(result.current.notifications).toHaveLength(2))
    await act(async () => answer(undefined))
    await waitFor(() => expect(result.current.notifications[1].read).toBe(0))
    expect(result.current.notifications[1].id).toBe('b')
  })

  it('marks a clicked notification read without fetching the list', async () => {
    const { result } = await mounted()
    const before = fetches()
    act(() => result.current.markAsRead('a'))
    await waitFor(() => expect(result.current.notifications[0].read).toBeGreaterThan(0))
    expect(fetches()).toBe(before)
  })
})
