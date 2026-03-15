import { authManager, useAuthStore } from '@mochi/common'

export type ShellBootstrapConfig = {
  userName?: string
  menuToken?: string
}

export async function bootstrapShellAuth(
  shellConfig?: ShellBootstrapConfig
): Promise<void> {
  const store = useAuthStore.getState()
  const menuToken = shellConfig?.menuToken?.trim() ?? ''
  const userName = shellConfig?.userName?.trim() ?? ''

  if (menuToken) {
    store.setToken(menuToken)
  }

  if (userName) {
    store.setProfile('', userName)
    return
  }

  if (menuToken) {
    await authManager.loadIdentity(true)
  }
}
