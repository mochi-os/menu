// Shell-managed subscribe-notifications dialog.
//
// Listens for 'subscribe-notifications' postMessage from app iframes, creates a
// subscription for each (app, object) item with no category, fetches available
// categories, and shows the user a category picker. Picking a category assigns
// it. Dismissing leaves the subscription unassigned — the pending-prompt flow
// will re-ask next time the user opens the owning app. Picking "No notifications"
// routes to the reserved suppress category (id 0) so it won't re-prompt.

import { useState, useEffect, useCallback } from 'react'
import { Check, Loader2 } from 'lucide-react'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Button,
  Skeleton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useAuthStore,
} from '@mochi/web'

const MENU_PATH = '/menu'

function getMenuToken(): string {
  return useAuthStore.getState().token || ''
}

interface SubscriptionItem {
  label: string
  topic?: string
  object?: string
}

interface PendingRow {
  id: number
  app: string
  topic: string
  object: string
  label: string
}

interface Category {
  id: number
  label: string
  default: number
}

interface PendingRequest {
  id: number
  app: string
  displayName: string
  items: SubscriptionItem[]
  source: WindowProxy | null
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

async function subscribe(app: string, label: string, topic: string, object: string, category: number | null): Promise<void> {
  const params = new URLSearchParams()
  params.append('app', app)
  params.append('label', label)
  if (topic) params.append('topic', topic)
  if (object) params.append('object', object)
  if (category !== null) params.append('category', String(category))
  await menuFetch('-/notifications/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
}

export function useSubscribeNotifications() {
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(false)
  // Per-item category selection, keyed by item index.
  const [selections, setSelections] = useState<Record<number, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const open = pending !== null

  // Listen for subscribe-notifications messages from app iframes
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'subscribe-notifications') return

      const source = event.source as WindowProxy | null
      const appId = (window as unknown as { __mochi_shell?: { appId?: string } }).__mochi_shell?.appId
      if (!appId) return

      const items: SubscriptionItem[] = data.items || []
      if (items.length === 0) return

      setPending({
        id: data.id,
        app: appId,
        displayName: data.app || appId,
        items,
        source,
      })
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // On open: create the unassigned subscriptions, fetch categories.
  useEffect(() => {
    if (!pending) {
      setCategories([])
      setSelections({})
      return
    }

    let cancelled = false
    setLoading(true)

    ;(async () => {
      try {
        const res = await menuFetch<{ data: Category[] }>('-/notifications/categories')
        if (cancelled) return
        const raw = res.data || []
        // Sort alphabetically by label, "No notifications" (id 0) last.
        const cats = [...raw].sort((a, b) => {
          if (a.id === 0) return 1
          if (b.id === 0) return -1
          return a.label.localeCompare(b.label)
        })
        setCategories(cats)
        // Preselect the user's default category for each item (fall back to first non-zero).
        const preferred = cats.find((c) => c.default === 1) ?? cats.find((c) => c.id !== 0) ?? cats[0]
        const initial: Record<number, string> = {}
        if (preferred) {
          pending.items.forEach((_, idx) => {
            initial[idx] = String(preferred.id)
          })
        }
        setSelections(initial)
      } catch {
        if (!cancelled) setCategories([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [pending])

  const respond = useCallback((result: string) => {
    if (pending) {
      pending.source?.postMessage(
        { type: 'subscribe-notifications-result', id: pending.id, result },
        '*'
      )
      setPending(null)
    }
  }, [pending])

  const allSelected = pending ? pending.items.every((_, idx) => selections[idx]) : false

  const handleAccept = useCallback(async () => {
    if (!pending || !allSelected) return
    setSubmitting(true)
    try {
      for (let i = 0; i < pending.items.length; i++) {
        const item = pending.items[i]
        const category = parseInt(selections[i], 10)
        await subscribe(pending.app, item.label, item.topic ?? '', item.object ?? '', category)
      }
      respond('accepted')
    } catch {
      respond('accepted')
    } finally {
      setSubmitting(false)
    }
  }, [pending, selections, allSelected, respond])

  // Closing via X or "Not now" leaves the subscription unassigned (null category)
  // so the pending prompt re-triggers next time the user opens the app.
  const handleDismiss = useCallback(() => {
    respond('declined')
  }, [respond])

  const appName = pending
    ? pending.displayName.charAt(0).toUpperCase() + pending.displayName.slice(1)
    : ''


  const dialog = open ? (
    <ResponsiveDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleDismiss()
      }}
    >
      <ResponsiveDialogContent className="max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Notifications</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{appName}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="py-4 space-y-4">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No categories available. Create one in settings → Notifications.
            </p>
          ) : (
            <div className="flex flex-col">
              {pending?.items.map((item, idx) => (
                <div
                  key={`${item.topic ?? ''}-${item.object ?? ''}-${idx}`}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span className="text-sm">{item.label}</span>
                  <Select
                    value={selections[idx] ?? ''}
                    onValueChange={(v) => setSelections((prev) => ({ ...prev, [idx]: v }))}
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((cat) => (
                        <SelectItem key={cat.id} value={String(cat.id)}>{cat.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </div>

        <ResponsiveDialogFooter className="flex-row gap-2 sm:justify-end">
          <Button onClick={handleAccept} disabled={submitting || !allSelected}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Save
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  ) : null

  // Pending-prompt polling: if an app has been opened and has any subscription with
  // a null category, simulate a subscribe-notifications request so the same dialog
  // handles it.
  useEffect(() => {
    let active = true
    async function check() {
      try {
        const appId = (window as unknown as { __mochi_shell?: { appId?: string } }).__mochi_shell?.appId
        if (!appId) return
        const res = await menuFetch<{ data: PendingRow[] }>(`-/notifications/pending?app=${encodeURIComponent(appId)}`)
        const rows = res.data || []
        if (!active || rows.length === 0) return
        if (pending) return // dialog already showing
        const items: SubscriptionItem[] = rows.map((r) => ({ label: r.label, topic: r.topic, object: r.object }))
        setPending({
          id: Date.now(),
          app: appId,
          displayName: appId,
          items,
          source: null,
        })
      } catch {
        // ignore
      }
    }
    const interval = window.setInterval(check, 30000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [pending])

  return { dialog }
}
