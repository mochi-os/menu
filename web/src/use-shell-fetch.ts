// Handles 'shell-fetch' postMessage requests from sandboxed iframes.
// The iframe cannot make authenticated requests directly (no cookies),
// so it proxies them through the shell via postMessage.

import { useEffect } from 'react'
import { useAuthStore } from '@mochi/web'

const MENU_PATH = '/menu'

function getMenuToken(): string {
  return useAuthStore.getState().token || ''
}

export function useShellFetch() {
  useEffect(() => {
    async function handleMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'shell-fetch') return

      const source = event.source as WindowProxy | null
      if (!source) return

      const { id, path, method, body } = data as {
        id: number
        path: string
        method: string
        body?: string
      }

      // Only allow menu app paths
      if (!path.startsWith('-/')) {
        source.postMessage({
          type: 'shell-fetch-result',
          id,
          ok: false,
          status: 403,
          data: { error: 'Forbidden' },
        }, '*')
        return
      }

      try {
        const token = getMenuToken()
        const res = await fetch(`${MENU_PATH}/${path}`, {
          method,
          credentials: 'same-origin',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          },
          body: body || undefined,
        })

        const responseData = await res.json().catch(() => ({}))

        source.postMessage({
          type: 'shell-fetch-result',
          id,
          ok: res.ok,
          status: res.status,
          data: responseData,
        }, '*')
      } catch {
        source.postMessage({
          type: 'shell-fetch-result',
          id,
          ok: false,
          status: 500,
          data: { error: 'Shell fetch failed' },
        }, '*')
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])
}
