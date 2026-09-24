// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The apps this browser has opened, most recent first, for the shortcuts
// beside the avatar. The menu is the top window, so localStorage here is the
// shell's own; entries are kept per signed-in identity.
import { useEffect, useState } from 'react'

const LIMIT = 10

function key(identity: string): string {
  return `menu:recent:${identity}`
}

function read(identity: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(key(identity)) || '[]'
    )
    return Array.isArray(parsed)
      ? parsed.filter((path): path is string => typeof path === 'string')
      : []
  } catch {
    return []
  }
}

/** Records the app on screen and returns the app paths, most recent first. */
export function useRecentApps(
  current: string,
  identity: string | null | undefined
): string[] {
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => {
    if (!identity) return
    const next = [
      current,
      ...read(identity).filter((path) => path !== current),
    ].slice(0, LIMIT)
    try {
      localStorage.setItem(key(identity), JSON.stringify(next))
    } catch {
      // localStorage unavailable (private mode, etc.): remember this page only
    }
    setRecent(next)
  }, [current, identity])

  return recent
}
