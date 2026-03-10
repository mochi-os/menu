// Auto-register browser push if permission is already granted.
// Also handles push-subscribe requests from app iframes via postMessage.

import { useEffect, useRef } from 'react'
import { requestHelpers, NOTIFICATIONS_PATH, push } from '@mochi/common'

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

async function getVapidKey(): Promise<string> {
  const res = await requestHelpers.getRaw<VapidKeyResponse>(
    `${NOTIFICATIONS_PATH}/-/accounts/vapid`
  )
  return res?.data?.key || ''
}

async function findBrowserAccount(): Promise<Account | null> {
  const res = await requestHelpers.getRaw<AccountsListResponse>(
    `${NOTIFICATIONS_PATH}/-/accounts/list?capability=notify`
  )
  const accounts = res?.data || []
  return accounts.find((a) => a.type === 'browser') || null
}

async function createBrowserAccount(sub: PushSubscription): Promise<number | null> {
  const data = push.getSubscriptionData(sub)
  const formData = new URLSearchParams()
  formData.append('type', 'browser')
  formData.append('endpoint', data.endpoint)
  formData.append('auth', data.auth)
  formData.append('p256dh', data.p256dh)
  formData.append('label', push.getBrowserName())

  await requestHelpers.post(
    `${NOTIFICATIONS_PATH}/-/accounts/add`,
    formData.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )

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
      const removeData = new URLSearchParams()
      removeData.append('id', String(existing.id))
      await requestHelpers.post(
        `${NOTIFICATIONS_PATH}/-/accounts/remove`,
        removeData.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      )
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
