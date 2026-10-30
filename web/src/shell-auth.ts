// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { authManager, shellIdentity, useAuthStore } from '@mochi/web'

type ShellBootstrapConfig = {
  menuToken?: string
  identity?: unknown
}

export async function bootstrapShellAuth(
  shellConfig?: ShellBootstrapConfig
): Promise<void> {
  const store = useAuthStore.getState()
  const menuToken = shellConfig?.menuToken?.trim() ?? ''

  if (menuToken) {
    store.setToken(menuToken)
    store.setInitialized()
    // /_/shell names who is signed in, so the menu draws at once rather than
    // a round trip later. A core older than the field sends none: the menu
    // then draws without the name and fills it in when /_/identity answers.
    const identity = shellIdentity(shellConfig?.identity)
    if (identity) {
      authManager.applyIdentity(identity)
    } else {
      void authManager.loadIdentity(true)
    }
  }
}
