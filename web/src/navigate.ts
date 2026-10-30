// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import type { MouseEvent } from 'react'
import { shellNavigateExternal } from '@mochi/web'

/**
 * Ask the shell page (public/shell.js, in this same window) to load a
 * same-origin address in its app frame, as an app's own cross-app link does,
 * rather than reloading the whole shell. False when the shell did not take
 * it, and the caller then navigates the ordinary way.
 */
export function navigateInPlace(url: string): boolean {
  const event = new CustomEvent('mochi-navigate', {
    detail: { url },
    cancelable: true,
  })
  return !window.dispatchEvent(event)
}

/**
 * A link's click handler that loads a plain left click in place. A middle or
 * modified click keeps the link's own behaviour: a new tab or window.
 */
export function clickInPlace(
  event: MouseEvent<HTMLAnchorElement>,
  after?: () => void
): void {
  const plain =
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  const href = event.currentTarget.getAttribute('href')
  if (plain && href && navigateInPlace(href)) event.preventDefault()
  after?.()
}

/**
 * Open a same-origin address in place, or by an ordinary navigation when the
 * shell does not take it.
 */
export function followInPlace(url: string): void {
  if (!navigateInPlace(url)) shellNavigateExternal(url)
}
