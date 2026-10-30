// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { authManager, useAuthStore } from '@mochi/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootstrapShellAuth } from './shell-auth'

// The menu used to wait for /_/identity before it drew: one round trip on
// every top-level load, for an identity /_/shell now reports itself.
describe('menu boot: the identity comes with the shell config', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useAuthStore.getState().clearAuth()
  })

  it('takes the identity /_/shell reports and asks nothing', async () => {
    const load = vi.spyOn(authManager, 'loadIdentity')
    await bootstrapShellAuth({
      menuToken: 'menu-token',
      identity: { id: 'identity-alice', name: 'Alice' },
    })
    const state = useAuthStore.getState()
    expect(state.token).toBe('menu-token')
    expect(state.identity).toBe('identity-alice')
    expect(state.name).toBe('Alice')
    expect(load).not.toHaveBeenCalled()
    // The profile cookie the sign-in page reads is refreshed, as the identity
    // load refreshed it.
    expect(decodeURIComponent(document.cookie)).toContain('"name":"Alice"')
  })

  it('asks /_/identity from an older core, without waiting for it', async () => {
    // An answer that never comes: a boot that waited for it would never end.
    const load = vi
      .spyOn(authManager, 'loadIdentity')
      .mockImplementation(() => new Promise(() => {}))
    await bootstrapShellAuth({ menuToken: 'menu-token' })
    expect(load).toHaveBeenCalledWith(true)
  })
})
