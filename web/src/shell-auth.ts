// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { authManager, useAuthStore } from '@mochi/web'

type ShellBootstrapConfig = {
  menuToken?: string
}

export async function bootstrapShellAuth(
  shellConfig?: ShellBootstrapConfig
): Promise<void> {
  const store = useAuthStore.getState()
  const menuToken = shellConfig?.menuToken?.trim() ?? ''

  if (menuToken) {
    store.setToken(menuToken)
    store.setInitialized()
    await authManager.loadIdentity(true)
  }
}
