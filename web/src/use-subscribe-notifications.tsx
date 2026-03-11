// Shell-managed subscribe-notifications dialog.
// Listens for 'subscribe-notifications' postMessage from app iframes,
// fetches destinations from menu backend, and shows a dialog for the user
// to choose notification preferences.

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Bell,
  Check,
  Globe,
  Loader2,
  Mail,
  Rss,
  Webhook,
} from 'lucide-react'
import { push } from '@mochi/common'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  Switch,
  Skeleton,
} from '@mochi/common'

const MENU_PATH = '/menu'

function getMenuToken(): string {
  return (window as unknown as { __mochi_shell?: { menuToken?: string } }).__mochi_shell?.menuToken ?? ''
}

interface SubscriptionItem {
  label: string
  type: string
  object?: string
  defaultEnabled?: boolean
}

interface Destination {
  type: 'account' | 'rss'
  accountType?: string
  id: number | string
  label: string
  identifier?: string
  defaultEnabled: boolean
}

interface DestinationToggle extends Destination {
  enabled: boolean
}

interface SubscriptionToggle extends SubscriptionItem {
  enabled: boolean
}

interface PendingRequest {
  id: number
  app: string
  subscriptions: SubscriptionItem[]
  source: WindowProxy
}

interface DestinationsResponse {
  data: {
    accounts: Array<{
      id: number
      type: string
      label: string
      identifier: string
      enabled: number
    }>
    feeds: Array<{
      id: string
      name: string
      enabled: number
    }>
  }
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

function getDestinationIcon(type: string, accountType?: string) {
  if (type === 'web') return <Globe className="h-4 w-4" />
  if (type === 'rss') return <Rss className="h-4 w-4" />
  switch (accountType) {
    case 'email': return <Mail className="h-4 w-4" />
    case 'browser': return <Bell className="h-4 w-4" />
    case 'url': return <Webhook className="h-4 w-4" />
    default: return <Bell className="h-4 w-4" />
  }
}

export function useSubscribeNotifications() {
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [loading, setLoading] = useState(false)
  const [toggles, setToggles] = useState<DestinationToggle[]>([])
  const [enableWeb, setEnableWeb] = useState(true)
  const [enableBrowserPush, setEnableBrowserPush] = useState(false)
  const [subscriptionToggles, setSubscriptionToggles] = useState<SubscriptionToggle[]>([])
  const [submitting, setSubmitting] = useState(false)

  const open = pending !== null

  // Listen for subscribe-notifications messages from app iframes
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'subscribe-notifications') return

      const source = event.source as WindowProxy | null
      if (!source) return

      setPending({
        id: data.id,
        app: data.app,
        subscriptions: data.subscriptions || [],
        source,
      })
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Fetch destinations when dialog opens
  useEffect(() => {
    if (!pending) {
      setDestinations([])
      setToggles([])
      setSubscriptionToggles([])
      setEnableWeb(true)
      setEnableBrowserPush(false)
      return
    }

    setLoading(true)
    menuFetch<DestinationsResponse>('-/notifications/destinations')
      .then((res) => {
        const accounts = (res.data?.accounts || []).map((a) => ({
          type: 'account' as const,
          accountType: a.type,
          id: a.id,
          label: a.label || a.identifier || a.type,
          identifier: a.identifier,
          defaultEnabled: a.enabled === 1,
        }))
        const feeds = (res.data?.feeds || []).map((f) => ({
          type: 'rss' as const,
          id: f.id,
          label: f.name,
          identifier: undefined,
          defaultEnabled: f.enabled === 1,
        }))
        const allDests = [...accounts, ...feeds]
        setDestinations(allDests)
        setToggles(allDests.map((d) => ({ ...d, enabled: d.defaultEnabled })))
      })
      .catch(() => {
        setDestinations([])
        setToggles([])
      })
      .finally(() => setLoading(false))

    // Initialize subscription toggles
    setSubscriptionToggles(
      pending.subscriptions.map((s) => ({ ...s, enabled: s.defaultEnabled ?? true }))
    )
  }, [pending])

  const browserDestination = destinations.find((d) => d.accountType === 'browser')
  const showBrowserPushOption = push.getPermission() !== 'denied' && !browserDestination

  const respond = useCallback((result: string) => {
    if (pending) {
      pending.source.postMessage(
        { type: 'subscribe-notifications-result', id: pending.id, result },
        '*'
      )
      setPending(null)
    }
  }, [pending])

  const handleAccept = useCallback(async () => {
    if (!pending) return
    setSubmitting(true)

    try {
      // If browser push was enabled, subscribe first
      let newBrowserAccountId: number | null = null
      if (enableBrowserPush && showBrowserPushOption) {
        try {
          const permission = await push.requestPermission()
          if (permission === 'granted') {
            const vapidRes = await menuFetch<{ data: { key: string } }>('-/push/vapid')
            const vapidKey = vapidRes?.data?.key
            if (vapidKey) {
              const sub = await push.subscribe(vapidKey)
              if (sub) {
                const subData = push.getSubscriptionData(sub)
                await menuFetch('-/push/accounts/add', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams({
                    type: 'browser',
                    endpoint: subData.endpoint,
                    auth: subData.auth,
                    p256dh: subData.p256dh,
                    label: push.getBrowserName(),
                  }).toString(),
                })
                // Find the new account
                const accRes = await menuFetch<{ data: Array<{ id: number; type: string }> }>(
                  '-/push/accounts/list?capability=notify'
                )
                const browserAcc = accRes?.data?.find((a) => a.type === 'browser')
                if (browserAcc) newBrowserAccountId = browserAcc.id
              }
            }
          }
        } catch {
          // Continue without browser push
        }
      }

      // Build destinations list
      const enabledDestinations: Array<{ type: string; target: string }> = []
      if (enableWeb) enabledDestinations.push({ type: 'web', target: 'default' })
      toggles.filter((t) => t.enabled).forEach((t) => {
        enabledDestinations.push({ type: t.type, target: String(t.id) })
      })
      if (newBrowserAccountId !== null) {
        enabledDestinations.push({ type: 'account', target: String(newBrowserAccountId) })
      }

      // Create subscriptions for each enabled type
      const enabledSubscriptions = subscriptionToggles.filter((s) => s.enabled)
      for (const sub of enabledSubscriptions) {
        const params = new URLSearchParams()
        params.append('app', pending.app)
        params.append('label', sub.label)
        if (sub.type) params.append('type', sub.type)
        if (sub.object) params.append('object', sub.object)
        params.append('destinations', JSON.stringify(enabledDestinations))

        await menuFetch('-/notifications/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        })
      }

      respond('accepted')
    } catch {
      respond('accepted')
    } finally {
      setSubmitting(false)
    }
  }, [pending, enableWeb, enableBrowserPush, showBrowserPushOption, toggles, subscriptionToggles, respond])

  const handleRefuse = useCallback(async () => {
    if (!pending) return
    setSubmitting(true)

    try {
      // Create subscriptions with no destinations (prevents re-prompting)
      for (const sub of pending.subscriptions) {
        const params = new URLSearchParams()
        params.append('app', pending.app)
        params.append('label', sub.label)
        if (sub.type) params.append('type', sub.type)
        if (sub.object) params.append('object', sub.object)
        params.append('destinations', '[]')

        await menuFetch('-/notifications/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        })
      }
    } catch {
      // Silently ignore
    }

    respond('declined')
    setSubmitting(false)
  }, [pending, respond])

  // Build sorted items list
  type UnifiedItem =
    | { kind: 'web' }
    | { kind: 'browser' }
    | { kind: 'toggle'; toggle: DestinationToggle }

  const sortedItems = useMemo((): UnifiedItem[] => {
    const items: Array<{ label: string; item: UnifiedItem }> = []
    items.push({ label: 'Mochi web', item: { kind: 'web' } })
    if (showBrowserPushOption) {
      items.push({ label: push.getBrowserName(), item: { kind: 'browser' } })
    }
    for (const toggle of toggles) {
      if (toggle.accountType === 'browser' && showBrowserPushOption) continue
      const displayLabel = toggle.accountType === 'email' && toggle.identifier
        ? toggle.identifier
        : toggle.label
      items.push({ label: displayLabel, item: { kind: 'toggle', toggle } })
    }
    items.sort((a, b) => a.label.localeCompare(b.label))
    return items.map((i) => i.item)
  }, [toggles, showBrowserPushOption])

  const showMultipleSubscriptions = subscriptionToggles.length > 1
  const appName = pending ? pending.app.charAt(0).toUpperCase() + pending.app.slice(1) : ''

  const dialog = open ? (
    <Dialog open={open} onOpenChange={(v) => { if (!v) respond('declined') }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Enable notifications</DialogTitle>
          <DialogDescription>
            <span className="font-medium">{appName}</span> would like to send you
            notifications{showMultipleSubscriptions ? '.' : `: ${subscriptionToggles[0]?.label ?? ''}`}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            <>
              {showMultipleSubscriptions && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Notify me about</p>
                  {subscriptionToggles.map((sub) => (
                    <div key={sub.type} className="flex items-center justify-between py-2">
                      <span className="text-sm">{sub.label}</span>
                      <Switch
                        id={`sub-toggle-${sub.type}`}
                        checked={sub.enabled}
                        onCheckedChange={() =>
                          setSubscriptionToggles((prev) =>
                            prev.map((s) => (s.type === sub.type ? { ...s, enabled: !s.enabled } : s))
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1">
                {showMultipleSubscriptions && (
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Deliver to</p>
                )}
                {sortedItems.map((item) => {
                  if (item.kind === 'web') {
                    return (
                      <div key="web" className="flex items-center justify-between py-2">
                        <div className="flex items-center gap-3">
                          <Globe className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm">Mochi web</span>
                        </div>
                        <Switch id="toggle-web" checked={enableWeb} onCheckedChange={setEnableWeb} />
                      </div>
                    )
                  }
                  if (item.kind === 'browser') {
                    return (
                      <div key="browser" className="flex items-center justify-between py-2">
                        <div className="flex items-center gap-3">
                          {getDestinationIcon('account', 'browser')}
                          <span className="text-sm">{push.getBrowserName()}</span>
                        </div>
                        <Switch
                          id="toggle-browser-push"
                          checked={enableBrowserPush}
                          onCheckedChange={setEnableBrowserPush}
                        />
                      </div>
                    )
                  }
                  const { toggle } = item
                  const displayLabel = toggle.accountType === 'email' && toggle.identifier
                    ? toggle.identifier
                    : toggle.label
                  return (
                    <div key={`${toggle.type}-${toggle.id}`} className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-3">
                        <span className="text-muted-foreground">
                          {getDestinationIcon(toggle.type, toggle.accountType)}
                        </span>
                        <span className="text-sm">{displayLabel}</span>
                      </div>
                      <Switch
                        id={`toggle-${toggle.type}-${toggle.id}`}
                        checked={toggle.enabled}
                        onCheckedChange={() =>
                          setToggles((prev) =>
                            prev.map((t) => (t.id === toggle.id ? { ...t, enabled: !t.enabled } : t))
                          )
                        }
                      />
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="flex-row gap-2 sm:justify-end">
          <Button variant="outline" onClick={handleRefuse} disabled={submitting}>
            Not now
          </Button>
          <Button onClick={handleAccept} disabled={submitting}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Enable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  return { dialog }
}
