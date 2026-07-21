// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { push } from '@mochi/web'
import { usePushRegistration } from './use-push-registration'

// The hook only installs a window 'message' listener; render it bare.
function Harness() {
  usePushRegistration()
  return null
}

let appFrame: HTMLIFrameElement
beforeEach(() => {
  appFrame = document.createElement('iframe')
  appFrame.id = 'app-frame'
  document.body.appendChild(appFrame)
})
afterEach(() => {
  appFrame.remove()
  vi.restoreAllMocks()
})

describe('usePushRegistration source guard', () => {
  it('ignores push-subscribe from a window that is not the app iframe', async () => {
    const requestPermission = vi
      .spyOn(push, 'requestPermission')
      .mockResolvedValue('granted')
    render(<Harness />)

    // A stale popup / nested frame the app opened, not #app-frame.
    const rogue = { postMessage: vi.fn() }
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'push-subscribe', id: 1 },
        source: rogue as unknown as WindowProxy,
      })
    )

    // Give any (incorrectly-scheduled) async handler a tick to run.
    await Promise.resolve()
    await Promise.resolve()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(rogue.postMessage).not.toHaveBeenCalled()
  })

  it('processes push-subscribe from the app iframe', async () => {
    const requestPermission = vi
      .spyOn(push, 'requestPermission')
      .mockResolvedValue('denied')
    render(<Harness />)

    const source = appFrame.contentWindow as WindowProxy
    const post = vi.spyOn(source, 'postMessage').mockImplementation(() => {})
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'push-subscribe', id: 2 },
        source,
      })
    )

    // The message is accepted, so permission is requested; denied short-circuits
    // and answers the requesting iframe.
    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        { type: 'push-result', id: 2, ok: false, reason: 'denied' },
        '*'
      )
    })
  })
})
