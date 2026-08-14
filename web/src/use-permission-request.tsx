// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Shell-managed permission request dialog.
// Listens for 'request-permission' postMessage from app iframes,
// shows a dialog for the user to grant or deny the permission.

import { useState, useEffect, useCallback } from 'react'
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

interface PendingRequest {
  id: number
  app: string
  permission: string
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

// Parse a request-permission message from an app iframe. Everything the app
// sends is untrusted input into the TRUSTED tree: the permission code is
// rendered while the server's translated name is in flight, and a non-string
// there throws during render, which unmounts the whole menu root — chrome,
// notification badge, sign-out and every later consent dialog with it. The
// shell-driven path has always type-checked its detail; this is the same rule
// on the path an app can actually reach.
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
  const [submitting, setSubmitting] = useState(false)
  const [permissionName, setPermissionName] = useState('')
  const [appName, setAppName] = useState('')
  // Server-resolved level of the pending permission. The requesting app's
  // self-asserted restricted flag is ignored — a lying app could otherwise
  // steer which dialog variant renders. Grants are enforced server-side
  // regardless, so defaulting to standard while the lookup is in flight is
  // safe: an early Allow on a restricted permission fails as denied.
  const [restricted, setRestricted] = useState(false)

  const open = pending !== null

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

      setPending({
        id: request.id,
        app: appId,
        permission: request.permission,
        source,
      })
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Shell-driven consent (same top window). shell.js dispatches this when it
  // needs the user's grant before running a capability it hosts on an app's
  // behalf (the microphone bridge). The sandboxed iframe can't reach the top
  // window's event bus, so only trusted shell code can fire it. The app being
  // granted is the shell's server-resolved current app id, never app input.
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
      setPending({
        id: 0,
        app: appId,
        permission: detail.permission,
        shellEventId: detail.id,
      })
    }
    window.addEventListener('mochi-shell-permission-request', handleShellRequest)
    return () => window.removeEventListener('mochi-shell-permission-request', handleShellRequest)
  }, [])

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
    setPending(null)
  }, [pending])

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

  const handleDeny = useCallback(() => {
    respond('denied')
  }, [respond])

  // Resolve the permission code to its translated name and its level. Both are
  // owned by core (mochi.permission.name / .level, exposed via the menu's
  // permissions/name action), so the dialog carries no permission vocabulary of
  // its own and never trusts the requesting app's restricted claim. The raw
  // code shows only briefly while the lookup is in flight, or if it fails.
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

  const dialog = open ? (
    <ResponsiveDialog open={open} onOpenChange={(v) => { if (!v) respond('denied') }}>
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
  ) : null

  return { dialog }
}
