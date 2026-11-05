// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// Notification fetching for the menu app — uses the menu's own backend
// instead of cross-app HTTP calls to the notifications app.
import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import {
  toast,
  getErrorMessage,
  websocketFailed,
  websocketOpened,
  websocketProtocols,
  websocketQueryToken,
  type Notification,
} from '@mochi/web'
import { menuFetch } from './menu-api'

interface NotificationsListResponse {
  data: Notification[]
}

const EMPTY_RESPONSE: NotificationsListResponse = { data: [] }

async function fetchNotifications(): Promise<NotificationsListResponse> {
  const response = await menuFetch<NotificationsListResponse>(
    '-/notifications/list'
  )
  if (!response || !Array.isArray(response.data)) return EMPTY_RESPONSE
  return response
}

async function markAsRead(id: string): Promise<void> {
  await menuFetch('-/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id }).toString(),
  })
}

async function markAllAsRead(): Promise<void> {
  await menuFetch('-/notifications/read/all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
  })
}

// Query keys
const notificationKeys = {
  all: () => ['menu-notifications'] as const,
  list: () => [...notificationKeys.all(), 'list'] as const,
}

// WebSocket singleton for real-time updates
const RECONNECT_DELAY = 3000

interface WebSocketState {
  instance: WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  subscriberCount: number
  queryClientRef: ReturnType<typeof useQueryClient> | null
  minting: boolean
}

const wsState: WebSocketState = {
  instance: null,
  reconnectTimer: null,
  subscriberCount: 0,
  queryClientRef: null,
  minting: false,
}

/** A notifications socket frame, as the notifications app writes it. */
export interface NotificationFrame extends Partial<Notification> {
  type?: string
  /** On a "new" frame: whether the bell lists the row at all. */
  web?: boolean
  /** On a clear_object frame: how many rows it changed. */
  changed?: number
}

/**
 * The bell's list once a frame is applied to it, or null when only fetching
 * the list again can say: a frame from a notifications app too old to carry
 * the row whole, or a clear, which names no rows. Downloading the whole list
 * for every frame cost each open tab its full size per notification, read and
 * open chat. The list stays as a fetch would answer it: oldest first, a row
 * hidden from the bell left out, a row sent again replacing the one held.
 */
export function notificationsAfter(
  list: Notification[],
  frame: NotificationFrame
): Notification[] | null {
  const now = Math.floor(Date.now() / 1000)
  switch (frame.type) {
    case 'new': {
      if (
        typeof frame.web !== 'boolean' ||
        typeof frame.id !== 'string' ||
        typeof frame.created !== 'number'
      )
        return null
      const rest = list.filter((row) => row.id !== frame.id)
      if (!frame.web) return rest.length === list.length ? list : rest
      const row: Notification = {
        id: frame.id,
        app: frame.app ?? '',
        topic: frame.topic ?? '',
        object: frame.object ?? '',
        content: frame.content ?? '',
        link: frame.link ?? '',
        sender: frame.sender ?? '',
        count: frame.count ?? 1,
        created: frame.created,
        read: frame.read ?? 0,
      }
      const after = rest.findIndex((held) => held.created > row.created)
      return after < 0
        ? [...rest, row]
        : [...rest.slice(0, after), row, ...rest.slice(after)]
    }
    case 'read':
      if (typeof frame.id !== 'string') return null
      return list.map((row) =>
        row.id === frame.id && !row.read ? { ...row, read: now } : row
      )
    case 'read_all':
      return list.map((row) => (row.read ? row : { ...row, read: now }))
  }
  return null
}

// Apply a frame to the held list, or fetch the list again when the frame
// cannot be applied. A fetch already under way answers from before the frame
// and would overwrite it on landing, so then the list is fetched again, which
// cancels that one, as every frame did before.
function applyFrame(
  queryClient: ReturnType<typeof useQueryClient>,
  frame: NotificationFrame
) {
  const fetching =
    queryClient.getQueryState(notificationKeys.list())?.fetchStatus ===
    'fetching'
  const held = fetching
    ? undefined
    : queryClient.getQueryData<NotificationsListResponse>(
        notificationKeys.list()
      )
  const next = held ? notificationsAfter(held.data, frame) : null
  if (held && next) {
    if (next !== held.data) {
      queryClient.setQueryData(notificationKeys.list(), { ...held, data: next })
    }
    return
  }
  void queryClient.invalidateQueries({ queryKey: notificationKeys.list() })
}

// The token rides in the subprotocol, so it stays out of the URL and out of
// every access log; only a page that has fallen back for a server which
// ignores it puts the token back in the query string.
function getWebSocketUrl(token: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const query = websocketQueryToken(token)
  const parameter = query ? `&token=${encodeURIComponent(query)}` : ''
  return `${protocol}//${window.location.host}/_/websocket?key=notifications${parameter}`
}

// The socket must carry a notifications-app token: delivery is scoped by the
// SENDING app, so only a socket tagged with that app hears its events. The
// session cookie authenticates but tags no app, and such a socket receives
// core's own sends and nothing else - the bell sat silent on it. Minted fresh
// on every connect so an expired token never wedges the reconnect loop.
async function mintNotificationsToken(): Promise<string | null> {
  try {
    const response = await fetch('/_/token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'notifications' }),
    })
    if (!response.ok) return null
    const data = (await response.json()) as { token?: string }
    return typeof data.token === 'string' && data.token !== ''
      ? data.token
      : null
  } catch {
    return null
  }
}

function broadcastToIframes(msg: Record<string, unknown>) {
  const iframes = document.querySelectorAll('iframe')
  for (const iframe of iframes) {
    iframe.contentWindow?.postMessage(msg, '*')
  }
}

function handleWebSocketMessage(event: MessageEvent) {
  if (!wsState.queryClientRef) return
  try {
    const data = JSON.parse(event.data) as NotificationFrame
    switch (data.type) {
      case 'new':
      case 'read':
      case 'read_all':
      case 'clear_all':
      case 'clear_app':
      case 'clear_object':
      // Which rows the bell lists changed with a topic's category or a
      // category's destinations: the frame names none, so the list is
      // fetched.
      case 'categories':
        // A clear is sent on every open of an object, for the phone; one that
        // changed no row changes nothing listed here or in the app frames.
        if (data.type === 'clear_object' && data.changed === 0) break
        applyFrame(wsState.queryClientRef, data)
        broadcastToIframes({ type: 'notification-update', event: data.type })
        break
    }
  } catch {
    // Ignore parse errors
  }
}

function connectWebSocket() {
  if (wsState.instance?.readyState === WebSocket.OPEN) return
  if (wsState.instance?.readyState === WebSocket.CONNECTING) return
  if (wsState.minting) return

  wsState.minting = true
  void mintNotificationsToken().then((token) => {
    wsState.minting = false
    if (wsState.subscriberCount === 0) return
    if (wsState.instance?.readyState === WebSocket.OPEN) return
    if (wsState.instance?.readyState === WebSocket.CONNECTING) return
    if (!token) {
      wsState.reconnectTimer = setTimeout(connectWebSocket, RECONNECT_DELAY)
      return
    }
    openWebSocket(token)
  })
}

function openWebSocket(token: string) {
  try {
    const protocols = websocketProtocols(token)
    const ws = new WebSocket(getWebSocketUrl(token), protocols)
    wsState.instance = ws
    // A handshake that never opens is how a server that ignores the token
    // subprotocol presents itself, and the next attempt then falls back.
    let established = false
    ws.onopen = () => {
      established = true
      websocketOpened(protocols)
      // Frames sent before the socket was open are lost: on a reconnect, and
      // on the first open, after a list read before it. Fetching cancels a
      // read under way, which may also be from before.
      void wsState.queryClientRef?.invalidateQueries({
        queryKey: notificationKeys.list(),
      })
    }
    ws.onmessage = handleWebSocketMessage
    ws.onclose = () => {
      if (!established) websocketFailed(protocols)
      // Only the current socket may act here: a stale socket's late close
      // event must not null out a replacement and spawn a duplicate
      // connection alongside it.
      if (wsState.instance !== ws) return
      wsState.instance = null
      if (wsState.subscriberCount > 0) {
        wsState.reconnectTimer = setTimeout(connectWebSocket, RECONNECT_DELAY)
      }
    }
    ws.onerror = () => {}
  } catch {
    if (wsState.subscriberCount > 0) {
      wsState.reconnectTimer = setTimeout(connectWebSocket, RECONNECT_DELAY)
    }
  }
}

function disconnectWebSocket() {
  if (wsState.reconnectTimer) {
    clearTimeout(wsState.reconnectTimer)
    wsState.reconnectTimer = null
  }
  if (wsState.instance) {
    // Detach before closing: close() completes asynchronously, and a
    // subscriber arriving in that window opens a replacement the old
    // socket's handlers must not touch.
    wsState.instance.onmessage = null
    wsState.instance.onclose = null
    wsState.instance.onerror = null
    wsState.instance.close()
    wsState.instance = null
  }
}

/**
 * The path the shell is showing, as segments. The menu runs in the top window,
 * so its own location is the one the reader sees.
 */
function shownPath(): string[] {
  return window.location.pathname.split('/').filter(Boolean)
}

/**
 * Whether a notification names exactly what the shell is showing.
 *
 * Only an exact match counts. Being in a chat or a game means the message it
 * announces has been read; sitting on a feed does not mean its posts have,
 * which is why a container must not retire anything under it.
 */
function readsOnSight(link: string, showing: string[]): boolean {
  if (showing.length < 2) return false
  const target = link.split('/').filter(Boolean)
  if (target.length !== showing.length) return false
  return target.every((segment, index) => segment === showing[index])
}

export function useMenuNotifications() {
  const queryClient = useQueryClient()
  const { t } = useLingui()

  const { data, isLoading, isError } = useQuery<NotificationsListResponse>({
    queryKey: notificationKeys.list(),
    queryFn: fetchNotifications,
    // WebSocket frames are the primary update path; poll slowly as a
    // fallback for sessions where the WebSocket can never connect (e.g. a
    // proxy that blocks upgrades), so the badge doesn't stay frozen.
    refetchInterval: 5 * 60 * 1000,
  })

  // A read lands in the held list as it is asked for, as its frame lands it
  // in every other tab: fetching the whole list again for it was a second
  // download on top of the frame's. Landing it when the answer came instead
  // marked read a notification whose frame arrived in between. A refused read
  // fetches the list again, and has to be said: silent, it reads as the click
  // having done nothing.
  const refused = () =>
    void queryClient.invalidateQueries({ queryKey: notificationKeys.list() })
  const markAsReadMutation = useMutation({
    mutationFn: markAsRead,
    onMutate: (id) => applyFrame(queryClient, { type: 'read', id }),
    onError: (error) => {
      refused()
      toast.error(
        getErrorMessage(error, t`Failed to mark notification as read`)
      )
    },
  })

  const markAllAsReadMutation = useMutation({
    mutationFn: markAllAsRead,
    onMutate: () => applyFrame(queryClient, { type: 'read_all' }),
    onError: (error) => {
      refused()
      toast.error(
        getErrorMessage(error, t`Failed to mark all notifications as read`)
      )
    },
  })

  // WebSocket for real-time updates
  useEffect(() => {
    wsState.queryClientRef = queryClient
    wsState.subscriberCount++
    if (wsState.subscriberCount === 1) {
      connectWebSocket()
    }
    // Hidden tabs throttle the reconnect timer to a minute or worse, so
    // reconnect as soon as the tab is visible; connect is a no-op when the
    // socket is up.
    const onVisible = () => {
      if (!document.hidden && wsState.subscriberCount > 0) connectWebSocket()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      wsState.subscriberCount--
      if (wsState.subscriberCount === 0) {
        disconnectWebSocket()
        wsState.queryClientRef = null
      }
    }
  }, [queryClient])

  const notifications = data?.data ?? []

  // Retire what the reader is already looking at, here and on their other
  // devices, so a notification for the open chat or game is never left waiting
  // in the bell. The shell owns the read endpoint and holds the list, so this
  // needs nothing from the app in the frame below.
  //
  // The iframe's own navigation only reaches the top window as a message, and
  // a pushState fires no popstate, so both are watched along with the list
  // itself: any of the three can be what makes a row match.
  const [shown, setShown] = useState<string[]>(shownPath)
  useEffect(() => {
    const follow = () => setShown(shownPath())
    const onMessage = (event: MessageEvent) => {
      const type = (event.data as { type?: string } | null)?.type
      if (type === 'navigate' || type === 'navigate-top') follow()
    }
    window.addEventListener('popstate', follow)
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('popstate', follow)
      window.removeEventListener('message', onMessage)
    }
  }, [])

  const markAsReadRef = useRef(markAsReadMutation.mutate)
  markAsReadRef.current = markAsReadMutation.mutate
  const retiring = useRef(new Set<string>())
  useEffect(() => {
    for (const notification of notifications) {
      if (notification.read) continue
      if (!readsOnSight(notification.link, shown)) continue
      // One attempt per row: the list is refetched after the read lands, and a
      // failed read must not spin.
      if (retiring.current.has(notification.id)) continue
      retiring.current.add(notification.id)
      markAsReadRef.current(notification.id)
    }
  }, [notifications, shown])

  return {
    notifications,
    isLoading,
    isError,
    markAsRead: (id: string) => markAsReadMutation.mutate(id),
    markAllAsRead: () => markAllAsReadMutation.mutate(),
  }
}
