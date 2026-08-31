// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Notification fetching for the menu app — uses the menu's own backend
// instead of cross-app HTTP calls to the notifications app.

import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { type Notification } from '@mochi/web'
import { menuFetch } from './menu-api'

interface NotificationsListResponse {
  data: Notification[]
}

const EMPTY_RESPONSE: NotificationsListResponse = { data: [] }

async function fetchNotifications(): Promise<NotificationsListResponse> {
  const response = await menuFetch<NotificationsListResponse>('-/notifications/list')
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

function getWebSocketUrl(token: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/_/websocket?key=notifications&token=${encodeURIComponent(token)}`
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
    return typeof data.token === 'string' && data.token !== '' ? data.token : null
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
    const data = JSON.parse(event.data)
    switch (data.type) {
      case 'new':
      case 'read':
      case 'read_all':
      case 'clear_all':
      case 'clear_app':
      case 'clear_object':
        wsState.queryClientRef.invalidateQueries({ queryKey: notificationKeys.list() })
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
    const ws = new WebSocket(getWebSocketUrl(token))
    wsState.instance = ws
    ws.onmessage = handleWebSocketMessage
    ws.onclose = () => {
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

export function useMenuNotifications() {
  const queryClient = useQueryClient()

  const { data, isLoading, isError } = useQuery<NotificationsListResponse>({
    queryKey: notificationKeys.list(),
    queryFn: fetchNotifications,
    // WebSocket invalidation is the primary update path; poll slowly as a
    // fallback for sessions where the WebSocket can never connect (e.g. a
    // proxy that blocks upgrades), so the badge doesn't stay frozen.
    refetchInterval: 5 * 60 * 1000,
  })

  const markAsReadMutation = useMutation({
    mutationFn: markAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all() })
    },
  })

  const markAllAsReadMutation = useMutation({
    mutationFn: markAllAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all() })
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

  return {
    notifications,
    isLoading,
    isError,
    markAsRead: (id: string) => markAsReadMutation.mutate(id),
    markAllAsRead: () => markAllAsReadMutation.mutate(),
  }
}
