// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'

// public/shell.js runs in the top-level shell window, outside the React tree,
// so it is read from disk and run as a script.
const SHELL = readFileSync(resolve(__dirname, '../public/shell.js'), 'utf8')

afterEach(() => {
  vi.unstubAllGlobals()
})

// The boot request carries the device's zone: the server keeps it as the
// user's zone while the preference is "auto", so its recurrences and
// reminders follow the device the user last used.
describe('shell boot request', () => {
  it('reports the device time zone in its body', () => {
    document.body.innerHTML =
      '<div id="app-container"></div><div id="menu"></div><div id="shell-progress"></div>'
    window.history.replaceState({}, '', '/feeds/')

    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ menuToken: 'menu-token', theme: '', appearance: 'auto' }),
        })
      })
    )

    new Function(SHELL)()

    const boot = calls.find((call) => call.url.indexOf('/_/shell') >= 0)
    expect(boot).toBeDefined()
    expect(boot?.init?.method).toBe('POST')
    const body = JSON.parse(String(boot?.init?.body)) as { timezone: string }
    expect(body.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(body.timezone.length).toBeGreaterThan(0)
  })
})
