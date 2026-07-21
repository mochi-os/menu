// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Auto-register browser push if permission is already granted.
// Also handles push-subscribe requests from app iframes via postMessage.
// All API calls go through the menu's own backend (cookie auth).

import { useEffect } from 'react'
import { push } from '@mochi/web'
import { menuFetch } from './menu-api'

interface VapidKeyResponse {
  data: { key: string }
}

interface Account {
  // Account ids are mochi.uid() text (notifications accounts table is `id text`),
  // not integers — a number type here made getLocalAccount reject every stored id.
  id: string
  type: string
  identifier: string
}

interface AccountsListResponse {
  data: Account[]
}

const LOCAL_ACCOUNT_KEY = 'mochi.push.account'

interface LocalAccount {
  id: string
  endpoint: string
}

function getLocalAccount(): LocalAccount | null {
  try {
    const raw = localStorage.getItem(LOCAL_ACCOUNT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.id !== 'string' || typeof parsed?.endpoint !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function setLocalAccount(account: LocalAccount | null): void {
  try {
    if (account) localStorage.setItem(LOCAL_ACCOUNT_KEY, JSON.stringify(account))
    else localStorage.removeItem(LOCAL_ACCOUNT_KEY)
  } catch {
    // localStorage unavailable (private mode, etc.) — skip
  }
}

async function removeAccountById(id: string): Promise<void> {
  try {
    await menuFetch('-/push/accounts/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id }).toString(),
    })
  } catch {
    // Account may already be gone server-side; don't block the flow
  }
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

async function createBrowserAccount(sub: PushSubscription): Promise<string | null> {
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
async function ensurePushRegistered(): Promise<string | null> {
  if (!(await push.isSupported())) return null

  const vapidKey = await getVapidKey()
  if (!vapidKey) return null

  // Subscribe (reuses existing subscription if present on this device)
  const sub = await push.subscribe(vapidKey)
  if (!sub) return null

  // Clean up any stale account this device previously created with a different
  // endpoint (Chrome rotates endpoints when the user revokes+regrants permission).
  const local = getLocalAccount()
  if (local && local.endpoint !== sub.endpoint) {
    await removeAccountById(local.id)
    setLocalAccount(null)
  }

  // Find the account matching this device's endpoint (other devices keep theirs).
  const existing = await findBrowserAccountByEndpoint(sub.endpoint)
  if (existing) {
    setLocalAccount({ id: existing.id, endpoint: sub.endpoint })
    return existing.id
  }

  const newId = await createBrowserAccount(sub)
  if (newId != null) setLocalAccount({ id: newId, endpoint: sub.endpoint })
  return newId
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
      const local = getLocalAccount()
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        const account = await findBrowserAccountByEndpoint(sub.endpoint)
        if (account) await removeAccountById(account.id)
        await sub.unsubscribe()
      }
      // Also remove any account remembered from a previous endpoint (e.g. Chrome
      // rotated the endpoint since we last subscribed).
      if (local && local.id !== undefined) await removeAccountById(local.id)
      setLocalAccount(null)
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
            } else {
              // Permission revoked in the browser — clean up the account we
              // created from this device so it doesn't linger as an orphan.
              const local = getLocalAccount()
              if (local) {
                await removeAccountById(local.id)
                setLocalAccount(null)
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
