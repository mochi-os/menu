import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, createQueryClient, useAuthStore } from '@mochi/common'
import { MochiShellMenu } from './shell-menu'
import './styles/index.css'

// Read the notification-scoped JWT from the shell page's meta tag.
// The shell embeds this so the menu app can make authenticated API calls
// to the notifications app (fetching notifications, managing push accounts).
const notifToken = document.querySelector('meta[name="mochi:token"]')?.getAttribute('content') || ''
if (notifToken) {
  useAuthStore.getState().setToken(notifToken)
}
// Set user name from shell config
const shellConfig = (window as unknown as { __mochi_shell?: { userName?: string } }).__mochi_shell
if (shellConfig?.userName) {
  useAuthStore.getState().setProfile('', shellConfig.userName)
}

const queryClient = createQueryClient()

createRoot(document.getElementById('menu')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MochiShellMenu />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
)
