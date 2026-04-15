// Auto-register browser push if permission is already granted.
// Also handles push-subscribe requests from app iframes via postMessage.
// All API calls go through the menu's own backend (cookie auth).

import { useEffect } from 'react'
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

async function findBrowserAccountByEndpoint(endpoint: string): Promise<Account | null> {
  const res = await menuFetch<AccountsListResponse>(
    '-/push/accounts/list?capability=notify'
  )
  const accounts = res?.data || []
  return accounts.find((a) => a.type === 'browser' && a.identifier === endpoint) || null
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

  return (await findBrowserAccountByEndpoint(data.endpoint))?.id ?? null
}

/** Ensure browser push is registered for THIS device. Returns the account ID or null. */
async function ensurePushRegistered(): Promise<number | null> {
  if (!(await push.isSupported())) return null

  const vapidKey = await getVapidKey()
  if (!vapidKey) return null

  // Subscribe (reuses existing subscription if present on this device)
  const sub = await push.subscribe(vapidKey)
  if (!sub) return null

  // Find the account matching this device's endpoint (other devices keep theirs).
  const existing = await findBrowserAccountByEndpoint(sub.endpoint)
  if (existing) return existing.id

  return createBrowserAccount(sub)
}

/**
 * Hook that listens for push-subscribe / -unsubscribe / -status requests from
 * app iframes. Registration is driven explicitly from the settings UI — we do
 * NOT auto-register on page load, because browser permission being 'granted'
 * does not mean the user currently wants push enabled (they may have disabled
 * it via the button, which cannot revoke browser permission).
 */
export function usePushRegistration() {
  useEffect(() => {
    async function removeBrowserAccount(): Promise<void> {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        const account = await findBrowserAccountByEndpoint(sub.endpoint)
        if (account) {
          await menuFetch('-/push/accounts/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ id: String(account.id) }).toString(),
          })
        }
        await sub.unsubscribe()
      }
    }

    function handleMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object') return
      const source = event.source as WindowProxy | null
      const id = data.id

      if (data.type === 'push-subscribe') {
        ;(async () => {
          try {
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
        return
      }

      if (data.type === 'push-unsubscribe') {
        ;(async () => {
          try {
            await removeBrowserAccount()
            source?.postMessage({ type: 'push-unsubscribe-result', id, ok: true }, '*')
          } catch {
            source?.postMessage({ type: 'push-unsubscribe-result', id, ok: false, reason: 'error' }, '*')
          }
        })()
        return
      }

      if (data.type === 'push-status') {
        ;(async () => {
          try {
            const permission = push.getPermission()
            let subscribed = false
            if (permission === 'granted' && (await push.isSupported())) {
              const reg = await navigator.serviceWorker.ready
              const sub = await reg.pushManager.getSubscription()
              if (sub) {
                const account = await findBrowserAccountByEndpoint(sub.endpoint)
                subscribed = !!account
              }
            }
            source?.postMessage(
              { type: 'push-status-result', id, ok: true, subscribed, permission },
              '*'
            )
          } catch {
            source?.postMessage({ type: 'push-status-result', id, ok: false, reason: 'error' }, '*')
          }
        })()
        return
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])
}
