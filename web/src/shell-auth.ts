import { authManager, useAuthStore } from '@mochi/web'

export type ShellBootstrapConfig = {
  menuToken?: string
}

export async function bootstrapShellAuth(
  shellConfig?: ShellBootstrapConfig
): Promise<void> {
  const store = useAuthStore.getState()
  const menuToken = shellConfig?.menuToken?.trim() ?? ''

  if (menuToken) {
    store.setToken(menuToken)
    await authManager.loadIdentity(true)
  }
}
