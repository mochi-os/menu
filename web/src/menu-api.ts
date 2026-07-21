// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Shared helpers for calling the menu app's own backend. The shell chrome runs
// in the top window, so it fetches /menu/-/... directly with the session cookie
// plus the menu's bearer token.

import { useAuthStore } from '@mochi/web'

export const MENU_PATH = '/menu'

export function getMenuToken(): string {
  return useAuthStore.getState().token || ''
}

export async function menuFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getMenuToken()
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log(`[menu-fetch] ${init?.method || 'GET'} ${path} token=${token ? 'present' : 'NONE'}`)
  }
  const res = await fetch(`${MENU_PATH}/${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...init?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error(`[menu-fetch] ${init?.method || 'GET'} ${path} -> ${res.status} ${body}`)
    }
    throw new Error(`Menu API error: ${res.status}`)
  }
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log(`[menu-fetch] ${init?.method || 'GET'} ${path} -> ${res.status}`)
  }
  return res.json()
}
