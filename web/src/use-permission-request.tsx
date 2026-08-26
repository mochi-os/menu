// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Shell-managed permission request dialog.
// Listens for 'request-permission' postMessage from app iframes,
// shows a dialog for the user to grant or deny the permission.

import { useState, useEffect, useCallback, useRef } from 'react'
import { Trans } from '@lingui/react/macro'
import { Shield, ShieldAlert, Check, Loader2 } from 'lucide-react'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Button,
} from '@mochi/web'
import { menuFetch } from './menu-api'
import { ChromeBoundary } from './chrome-boundary'

interface PendingRequest {
  id: number
  app: string
  permission: string
  // Keys the boundary around the dialog so each request gets a fresh one. Not
  // the app's `id`: a repeated value would stop the remount exactly when a
  // hostile app caused the failure.
  sequence: number
  // Set for the normal iframe-driven request: where the result is posted back.
  source?: WindowProxy
  // Set for a shell-driven request (e.g. the microphone gate in shell.js): the
  // result is returned via a same-window CustomEvent keyed by this id instead.
  shellEventId?: string
}

// A permission code long enough to distort the dialog is refused outright
// rather than truncated: the dialog is a place to be sure of what is being
// asked, not to guess at a clipped string.
const PERMISSION_MAXIMUM = 256

// A denial is an answer, not an invitation to ask again. Without a cooldown an
// app can post request-permission in a loop until a click lands on Allow, and
// every permission the dialog can grant is worth stealing - camera, microphone,
// accounts/read, entity/read, user/sessions/write.
const DENIAL_COOLDOWN = 60000

// A dialog may not open immediately after one closes. The footers differ by
// level - restricted is a single full-width Close, standard is Deny beside
// Allow - so Allow sits under the right half of where Close was. Without this
// gap the second half of a double-click lands on a button that was not there
// for the first.
const DIALOG_INTERVAL = 750

// NUL appears in neither an app id nor a permission code, so an app cannot
// forge a pair by choosing a permission that spans the separator.
function denialKey(app: string, permission: string): string {
  return app + '\u0000' + permission
}

// Bounded by how often the user clicks Deny, but pruned on write so the map
// cannot accumulate entries for permission codes an app invents.
function prune(denials: Map<string, number>, now: number): void {
  for (const [key, at] of denials) {
    if (now - at >= DENIAL_COOLDOWN) denials.delete(key)
  }
}

// Everything the app sends is untrusted input into the trusted tree: a
// non-string permission code throws during render and unmounts the whole menu
// root.
function parsePermissionRequest(data: unknown): { id: number; permission: string } | null {
  if (!data || typeof data !== 'object') return null
  const message = data as { id?: unknown; permission?: unknown }
  if (typeof message.id !== 'number' || !Number.isFinite(message.id)) return null
  if (typeof message.permission !== 'string') return null
  const permission = message.permission.trim()
  if (!permission || permission.length > PERMISSION_MAXIMUM) return null
  return { id: message.id, permission }
}

export function usePermissionRequest() {
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const sequence = useRef(0)
  const [submitting, setSubmitting] = useState(false)
  const [permissionName, setPermissionName] = useState('')
  const [appName, setAppName] = useState('')
  // Server-resolved level; the app's own restricted flag is ignored. Defaulting
  // to standard while the lookup is in flight is safe: grants are enforced
  // server-side.
  const [restricted, setRestricted] = useState(false)
  // The message handlers are registered once and never see `pending` through
  // their closure, so admission is decided against refs rather than state.
  const active = useRef(false)
  const closed = useRef(0)
  const denials = useRef(new Map<string, number>())

  const open = pending !== null

  // Whether a request may open a dialog now. Refusing is not silence: every
  // caller answers 'denied' so the app's promise settles rather than waiting
  // out its own timeout.
  const admit = useCallback((app: string, permission: string): boolean => {
    if (active.current) return false
    const now = Date.now()
    if (now - closed.current < DIALOG_INTERVAL) return false
    const denied = denials.current.get(denialKey(app, permission))
    return denied === undefined || now - denied >= DENIAL_COOLDOWN
  }, [])

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'request-permission') return

      // Only the loaded app iframe may drive the consent dialog — reject
      // messages from nested or sibling frames.
      const appFrame = document.getElementById('app-frame') as HTMLIFrameElement | null
      if (!appFrame || event.source !== appFrame.contentWindow) return
      const source = event.source as WindowProxy | null
      if (!source) return

      // The app being granted comes from the shell's own server-resolved app id,
      // never the self-asserted data.app: an app must not be able to name a
      // different app in the dialog or grant a permission to one. The shell loads
      // exactly one app at a time and sets __mochi_shell.appId from /_/token.
      const appId = (window as unknown as { __mochi_shell?: { appId?: string } })
        .__mochi_shell?.appId
      if (!appId) return

      const request = parsePermissionRequest(data)
      if (!request) return

      if (!admit(appId, request.permission)) {
        source.postMessage(
          { type: 'permission-result', id: request.id, result: 'denied' },
          '*'
        )
        return
      }

      active.current = true
      sequence.current += 1
      setPending({
        id: request.id,
        app: appId,
        permission: request.permission,
        source,
        sequence: sequence.current,
      })
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [admit])

  // Shell-driven consent (microphone bridge): only trusted shell code can fire
  // a same-window CustomEvent, and the app granted is the shell's
  // server-resolved current app id.
  useEffect(() => {
    function handleShellRequest(event: Event) {
      const detail = (event as CustomEvent).detail
      if (!detail || typeof detail.id !== 'string' || typeof detail.permission !== 'string') return
      const appId = (window as unknown as { __mochi_shell?: { appId?: string } })
        .__mochi_shell?.appId
      if (!appId) {
        window.dispatchEvent(
          new CustomEvent('mochi-shell-permission-result', {
            detail: { id: detail.id, result: 'denied' },
          })
        )
        return
      }
      // The shell raises this on the app's behalf (mic.open, camera.open), so
      // it is app-triggerable too and takes the same admission gate.
      if (!admit(appId, detail.permission)) {
        window.dispatchEvent(
          new CustomEvent('mochi-shell-permission-result', {
            detail: { id: detail.id, result: 'denied' },
          })
        )
        return
      }
      active.current = true
      sequence.current += 1
      setPending({
        id: 0,
        app: appId,
        permission: detail.permission,
        shellEventId: detail.id,
        sequence: sequence.current,
      })
    }
    window.addEventListener('mochi-shell-permission-request', handleShellRequest)
    return () => window.removeEventListener('mochi-shell-permission-request', handleShellRequest)
  }, [admit])

  const respond = useCallback((result: string) => {
    if (!pending) return
    if (pending.shellEventId) {
      window.dispatchEvent(
        new CustomEvent('mochi-shell-permission-result', {
          detail: { id: pending.shellEventId, result },
        })
      )
    } else if (pending.source) {
      pending.source.postMessage(
        { type: 'permission-result', id: pending.id, result },
        '*'
      )
    }
    active.current = false
    closed.current = Date.now()
    setPending(null)
  }, [pending])

  // The user said no. Recorded so the same app cannot ask again for the same
  // permission until the cooldown expires. A grant that fails on the way to
  // the server answers 'denied' through respond() instead: that is our failure,
  // not the user's answer, and must not lock out a retry.
  const refuse = useCallback(() => {
    if (pending) {
      const now = Date.now()
      prune(denials.current, now)
      denials.current.set(denialKey(pending.app, pending.permission), now)
    }
    respond('denied')
  }, [pending, respond])

  // The dialog died in render, so the user was never asked. Answer denied and
  // free the slot: the request cannot be granted, and leaving it occupying the
  // slot would wedge consent for the rest of the session. No cooldown recorded
  // - a render failure is not the user's answer.
  const handleFailure = useCallback(() => {
    respond('denied')
  }, [respond])

  const handleAllow = useCallback(async () => {
    if (!pending) return
    setSubmitting(true)

    try {
      await menuFetch('-/permissions/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          app: pending.app,
          permission: pending.permission,
        }).toString(),
      })
      respond('granted')
    } catch {
      respond('denied')
    } finally {
      setSubmitting(false)
    }
  }, [pending, respond])

  const handleDeny = refuse

  // Resolve the code to its translated name and level from core
  // (permissions/name); the raw code shows only while the lookup is in flight
  // or if it fails.
  useEffect(() => {
    if (!pending) {
      setPermissionName('')
      setRestricted(false)
      return
    }
    const code = pending.permission
    setPermissionName(code)
    setRestricted(false)
    let cancelled = false
    menuFetch<{ data?: { name?: string; restricted?: boolean } }>('-/permissions/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ permission: code }).toString(),
    })
      .then((body) => {
        if (cancelled) return
        if (body?.data?.name) setPermissionName(body.data.name)
        setRestricted(!!body?.data?.restricted)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pending])

  // Resolve the app id to its display name. The id is the shell's server-
  // resolved current app id — on production installs it's an entity id, so the
  // dialog must not show it raw. The raw id shows only briefly while the
  // lookup is in flight, or if it fails.
  useEffect(() => {
    if (!pending) {
      setAppName('')
      return
    }
    setAppName(pending.app)
    let cancelled = false
    menuFetch<{ data?: { name?: string } }>('-/permissions/application', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ app: pending.app }).toString(),
    })
      .then((body) => {
        if (!cancelled && body?.data?.name) setAppName(body.data.name)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pending])

  // Keyed per request: the boundary never clears its failed state, so without a
  // fresh instance one throw would blank every later consent dialog until
  // reload.
  const dialog = open ? (
    <ChromeBoundary key={pending.sequence} onFailure={handleFailure}>
    <ResponsiveDialog open={open} onOpenChange={(v) => { if (!v) refuse() }}>
      <ResponsiveDialogContent className="permission-dialog max-w-sm">
        <ResponsiveDialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            {restricted ? (
              <ShieldAlert className="h-6 w-6 text-amber-500" />
            ) : (
              <Shield className="h-6 w-6 text-primary" />
            )}
          </div>
          <ResponsiveDialogTitle className="text-center"><Trans>Permission request</Trans></ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-center">
            <Trans><span className="font-medium">{appName}</span> is requesting the following permission:</Trans>
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="rounded-lg border px-4 py-3 text-center text-sm font-medium">
          {permissionName}
        </div>

        {restricted && (
          <p className="text-sm text-amber-600 text-center">
            <Trans>This permission must be enabled by you in the app settings.</Trans>
          </p>
        )}

        <ResponsiveDialogFooter className="flex-row gap-2 sm:justify-end">
          {restricted ? (
            <Button variant="outline" className="flex-1" onClick={handleDeny}>
              <Trans>Close</Trans>
            </Button>
          ) : (
            <>
              <Button variant="outline" className="flex-1" onClick={handleDeny} disabled={submitting}>
                <Trans>Deny</Trans>
              </Button>
              <Button className="flex-1" onClick={handleAllow} disabled={submitting}>
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                <Trans>Allow</Trans>
              </Button>
            </>
          )}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
    </ChromeBoundary>
  ) : null

  return { dialog }
}
