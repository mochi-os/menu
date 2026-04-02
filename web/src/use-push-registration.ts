// Auto-register browser push if permission is already granted.
// Also handles push-subscribe requests from app iframes via postMessage.
// All API calls go through the menu's own backend (cookie auth).

import { useEffect, useRef } from 'react'
import { push, useAuthStore } from '@mochi/web'

const MENU_PATH = '/menu'

function getMenuToken(): string {
  return useAuthStore.getState().token || ''
}

interface VapidKeyResponse {
  data: { key: string }
}

interface Account {
  id: number
  type: string
  identifier: string
}

interface AccountsListResponse {
  data: Account[]
}

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

async function getVapidKey(): Promise<string> {
  const res = await menuFetch<VapidKeyResponse>('-/push/vapid')
  return res?.data?.key || ''
}

async function findBrowserAccount(): Promise<Account | null> {
  const res = await menuFetch<AccountsListResponse>(
    '-/push/accounts/list?capability=notify'
  )
  const accounts = res?.data || []
  return accounts.find((a) => a.type === 'browser') || null
}

async function createBrowserAccount(sub: PushSubscription): Promise<number | null> {
  const data = push.getSubscriptionData(sub)
  await menuFetch('-/push/accounts/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      type: 'browser',
      endpoint: data.endpoint,
      auth: data.auth,
      p256dh: data.p256dh,
      label: push.getBrowserName(),
    }).toString(),
  })

  // Fetch the account to get its ID
  const account = await findBrowserAccount()
  return account?.id ?? null
}

/** Ensure browser push is registered. Returns the account ID or null. */
async function ensurePushRegistered(): Promise<number | null> {
  if (!(await push.isSupported())) return null

  const vapidKey = await getVapidKey()
  if (!vapidKey) return null

  // Subscribe (reuses existing subscription if present)
  const sub = await push.subscribe(vapidKey)
  if (!sub) return null

  // Check if a browser account already exists with this endpoint
  const existing = await findBrowserAccount()
  if (existing) {
    // Check if the endpoint matches — if not, update it
    if (existing.identifier !== sub.endpoint) {
      // Remove stale account and create fresh
      await menuFetch('-/push/accounts/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id: String(existing.id) }).toString(),
      })
      return createBrowserAccount(sub)
    }
    return existing.id
  }

  return createBrowserAccount(sub)
}

/**
 * Hook that:
 * 1. Auto-registers push if permission is already granted
 * 2. Listens for push-subscribe requests from app iframes
 */
export function usePushRegistration() {
  const registering = useRef(false)

  useEffect(() => {
    // Auto-register if permission is already granted (user previously allowed)
    if (push.getPermission() === 'granted' && !registering.current) {
      registering.current = true
      ensurePushRegistered()
        .catch(() => {})
        .finally(() => { registering.current = false })
    }

    // Listen for push-subscribe requests from app iframes
    function handleMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'push-subscribe') return

      const source = event.source as WindowProxy | null
      const id = data.id

      ;(async () => {
        try {
          // Request permission if not yet granted
          const permission = await push.requestPermission()
          if (permission !== 'granted') {
            source?.postMessage({ type: 'push-result', id, ok: false, reason: 'denied' }, '*')
            return
          }

          const accountId = await ensurePushRegistered()
          if (accountId != null) {
            source?.postMessage({ type: 'push-result', id, ok: true, accountId }, '*')
          } else {
            source?.postMessage({ type: 'push-result', id, ok: false, reason: 'failed' }, '*')
          }
        } catch {
          source?.postMessage({ type: 'push-result', id, ok: false, reason: 'error' }, '*')
        }
      })()
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])
}
