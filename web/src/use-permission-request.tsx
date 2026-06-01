// Shell-managed permission request dialog.
// Listens for 'request-permission' postMessage from app iframes,
// shows a dialog for the user to grant or deny the permission.

import { useState, useEffect, useCallback } from 'react'
import { Trans } from '@lingui/react/macro'
import { Shield, ShieldAlert, Loader2 } from 'lucide-react'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Button,
  useAuthStore,
} from '@mochi/web'

const MENU_PATH = '/menu'

function getMenuToken(): string {
  return useAuthStore.getState().token || ''
}

interface PendingRequest {
  id: number
  app: string
  permission: string
  restricted: boolean
  source: WindowProxy
}

export function usePermissionRequest() {
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [permissionName, setPermissionName] = useState('')

  const open = pending !== null

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'request-permission') return

      // Diagnostic logging for ticket mochi-dev-185 — remove once resolved
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log('[menu debug 185] request-permission received', {
          id: data.id,
          app: data.app,
          permission: data.permission,
          restricted: data.restricted,
          hasSource: !!event.source,
        })
      }

      const source = event.source as WindowProxy | null
      if (!source) return

      setPending({
        id: data.id,
        app: data.app,
        permission: data.permission,
        restricted: data.restricted,
        source,
      })
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  const respond = useCallback((result: string) => {
    if (pending) {
      pending.source.postMessage(
        { type: 'permission-result', id: pending.id, result },
        '*'
      )
      setPending(null)
    }
  }, [pending])

  const handleAllow = useCallback(async () => {
    if (!pending) return
    setSubmitting(true)

    try {
      const token = getMenuToken()
      const res = await fetch(`${MENU_PATH}/-/permissions/grant`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: new URLSearchParams({
          app: pending.app,
          permission: pending.permission,
        }).toString(),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Error ${res.status}`)
      }

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

  // Resolve the permission code to its translated name. Names are owned by core
  // (mochi.permission.name, exposed via the menu's permissions/name action), so
  // the dialog carries no permission vocabulary of its own. The raw code shows
  // only briefly while the lookup is in flight, or if it fails.
  useEffect(() => {
    if (!pending) {
      setPermissionName('')
      return
    }
    const code = pending.permission
    setPermissionName(code)
    let cancelled = false
    const token = getMenuToken()
    fetch(`${MENU_PATH}/-/permissions/name`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: new URLSearchParams({ permission: code }).toString(),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body?.data?.name) setPermissionName(body.data.name)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pending])

  const appName = pending ? pending.app.charAt(0).toUpperCase() + pending.app.slice(1) : ''

  const dialog = open ? (
    <ResponsiveDialog open={open} onOpenChange={(v) => { if (!v) respond('denied') }}>
      <ResponsiveDialogContent className="max-w-sm">
        <ResponsiveDialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            {pending.restricted ? (
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

        {pending.restricted && (
          <p className="text-sm text-amber-600 text-center">
            <Trans>This permission must be enabled by you in the app settings.</Trans>
          </p>
        )}

        <ResponsiveDialogFooter className="flex-row gap-2 sm:justify-end">
          {pending.restricted ? (
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
                  <Trans>Allow</Trans>
                )}
              </Button>
            </>
          )}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  ) : null

  return { dialog }
}
