// Notification fetching for the menu app — uses the menu's own backend
// instead of cross-app HTTP calls to the notifications app.

import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Notification } from '@mochi/common'

const MENU_PATH = '/menu'

function getMenuToken(): string {
  return (window as unknown as { __mochi_shell?: { menuToken?: string } }).__mochi_shell?.menuToken ?? ''
}

interface NotificationsListResponse {
  data: Notification[]
  count: number
  total: number
}

const EMPTY_RESPONSE: NotificationsListResponse = { data: [], count: 0, total: 0 }

async function menuFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getMenuToken()
  const res = await fetch(`${MENU_PATH}/${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...init?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) throw new Error(`Menu API error: ${res.status}`)
  return res.json()
}

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
    wsState.instance.close()
    wsState.instance = null
  }
}

export function useMenuNotifications() {
  const queryClient = useQueryClient()

  const { data, isLoading, isError } = useQuery<NotificationsListResponse>({
    queryKey: notificationKeys.list(),
    queryFn: fetchNotifications,
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
    return () => {
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
