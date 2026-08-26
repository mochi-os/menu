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
  const res = await menuFetch<{ data?: { id?: string | number } }>('-/push/accounts/add', {
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

  // The add response carries the new account (mochi.account.add), so the id is
  // normally right here; the list lookup remains as a fallback only.
  const id = res?.data?.id
  if (id !== undefined && id !== null && id !== '') return String(id)
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

/** How long to wait for shell.js to resolve an app id before failing closed. */
const APP_TIMEOUT = 5000

/**
 * The app id the shell resolved for the current path. shell.js sets it only
 * after `/_/token` answers, so a frame asking during its first render can beat
 * it - a single read would report "no permission". It announces every change
 * as `mochi-shell-app-changed`, so waiting for that beats polling: a poll
 * cannot distinguish "the id this frame was waiting for" from "the id the
 * NEXT app installed while we waited".
 */
function shellAppId(): Promise<string | null> {
  const current = (window as { __mochi_shell?: { appId?: string | null } }).__mochi_shell?.appId
  if (current) return Promise.resolve(current)
  return new Promise((resolve) => {
    const done = (app: string | null) => {
      clearTimeout(timer)
      window.removeEventListener('mochi-shell-app-changed', listener)
      resolve(app)
    }
    function listener(event: Event) {
      const app = (event as CustomEvent).detail?.app
      if (typeof app === 'string' && app) done(app)
    }
    const timer = setTimeout(() => done(null), APP_TIMEOUT)
    window.addEventListener('mochi-shell-app-changed', listener)
  })
}

/**
 * Whether the app in the frame holds `notifications/write`. Resolved against
 * the app id the server picked for the path, never a name the message carries,
 * and fails closed: no app id yet, a failed check, or no grant all mean no.
 *
 * `frame` is the iframe element the request arrived from, pinned at message
 * time. Resolving an id can take until `/_/token` answers, and a navigation in
 * that window would install the NEXT app's id - so the frame is re-checked
 * afterwards. shell.js builds a new element per navigation and strips the old
 * one's id, so a frame that is no longer `#app-frame` did not survive it, and
 * the id that arrived is not the one this request should be judged against.
 */
async function pushAllowed(frame: HTMLIFrameElement): Promise<boolean> {
  const app = await shellAppId()
  if (!app) return false
  if (document.getElementById('app-frame') !== frame) return false
  try {
    const res = await menuFetch<{ data?: { granted?: boolean } }>('-/permissions/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `app=${encodeURIComponent(app)}&permission=${encodeURIComponent('notifications/write')}`,
    })
    return !!res?.data?.granted
  } catch {
    return false
  }
}

/**
 * Listens for push-subscribe / -unsubscribe / -status requests from app
 * iframes. Never auto-registers on load: browser permission 'granted' does not
 * mean the user wants push on (disabling via the button cannot revoke the
 * permission).
 */
export function usePushRegistration() {
  useEffect(() => {
    async function removeBrowserAccount(): Promise<void> {
      const local = getLocalAccount()
      // getRegistration, not serviceWorker.ready: ready never settles when
      // nothing is registered, and no registration is the ordinary state here.
      const reg = (await push.isSupported())
        ? await navigator.serviceWorker.getRegistration()
        : undefined
      const sub = reg ? await reg.pushManager.getSubscription() : null
      if (sub) {
        const account = await findBrowserAccountByEndpoint(sub.endpoint)
        if (account) await removeAccountById(account.id)
        await sub.unsubscribe()
      }
      // Also remove any account remembered from a previous endpoint (e.g. Chrome
      // rotated the endpoint since we last subscribed). Reachable now even with
      // no registration, which is exactly when such a row is left stranded.
      if (local && local.id !== undefined) await removeAccountById(local.id)
      setLocalAccount(null)
    }

    function handleMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object') return
      // Only the currently-loaded app iframe may drive push state — mirror the
      // permission hook's check. Without it a stale popup or nested frame that
      // kept a handle to this window could subscribe, unsubscribe, or read the
      // push account after the user moved on to another app.
      const appFrame = document.getElementById('app-frame') as HTMLIFrameElement | null
      if (!appFrame || event.source !== appFrame.contentWindow) return
      const source = event.source as WindowProxy | null
      const id = data.id

      if (data.type === 'push-subscribe') {
        ;(async () => {
          try {
            if (!(await pushAllowed(appFrame))) {
              source?.postMessage({ type: 'push-result', id, ok: false, reason: 'forbidden' }, '*')
              return
            }
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
            if (!(await pushAllowed(appFrame))) {
              source?.postMessage(
                { type: 'push-unsubscribe-result', id, ok: false, reason: 'forbidden' },
                '*'
              )
              return
            }
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
            if (!(await pushAllowed(appFrame))) {
              source?.postMessage(
                { type: 'push-status-result', id, ok: false, reason: 'forbidden' },
                '*'
              )
              return
            }
            const permission = push.getPermission()
            let subscribed = false
            if (permission === 'granted' && (await push.isSupported())) {
              // Granted permission does not imply a registration exists (it
              // outlives cleared site data); serviceWorker.ready would hang.
              const reg = await navigator.serviceWorker.getRegistration()
              const sub = reg ? await reg.pushManager.getSubscription() : null
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
