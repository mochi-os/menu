// Shell-managed permission request dialog.
// Listens for 'request-permission' postMessage from app iframes,
// shows a dialog for the user to grant or deny the permission.

import { useState, useEffect, useCallback } from 'react'
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

function getPermissionLabel(permission: string): string {
  const labels: Record<string, string> = {
    'accounts/read': 'read connected accounts',
    'accounts/manage': 'manage connected accounts',
    'accounts/ai': 'use AI services',
    'accounts/mcp': 'connect to MCP servers',
    'groups/manage': 'manage groups',
    'interests/read': 'read interests',
    'interests/write': 'write interests',
  }

  if (labels[permission]) return labels[permission]

  if (permission.startsWith('url:')) {
    const domain = permission.slice(4)
    return `access ${domain}`
  }

  return permission
}

export function usePermissionRequest() {
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const open = pending !== null

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'request-permission') return

      // Diagnostic logging for ticket mochi-dev-185 — remove once resolved
      console.log('[menu debug 185] request-permission received', {
        id: data.id,
        app: data.app,
        permission: data.permission,
        restricted: data.restricted,
        hasSource: !!event.source,
      })

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

  const appName = pending ? pending.app.charAt(0).toUpperCase() + pending.app.slice(1) : ''
  const permissionLabel = pending ? getPermissionLabel(pending.permission) : ''

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
          <ResponsiveDialogTitle className="text-center">Permission request</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-center">
            <span className="font-medium">{appName}</span> wants permission to {permissionLabel}.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {pending.restricted && (
          <p className="text-sm text-amber-600 text-center">
            This permission must be enabled by you in the app settings.
          </p>
        )}

        <ResponsiveDialogFooter className="flex-row gap-2 sm:justify-end">
          {pending.restricted ? (
            <Button variant="outline" className="flex-1" onClick={handleDeny}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" className="flex-1" onClick={handleDeny} disabled={submitting}>
                Deny
              </Button>
              <Button className="flex-1" onClick={handleAllow} disabled={submitting}>
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'Allow'
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
