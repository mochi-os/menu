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
}

const wsState: WebSocketState = {
  instance: null,
  reconnectTimer: null,
  subscriberCount: 0,
  queryClientRef: null,
}

function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/_/websocket?key=notifications`
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

  try {
    const ws = new WebSocket(getWebSocketUrl())
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
    // A socket that drops in a background tab reconnects only through its
    // own timer, which the browser throttles to once a minute or worse for
    // hidden tabs - so a tab could sit with a dead socket, miss every
    // event, and only look right again on focus because the focus refetch
    // masked it. Reconnect the moment the tab is visible again; connect is
    // a no-op when the socket is already up.
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
