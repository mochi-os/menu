import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, createQueryClient } from '@mochi/web'
import { MochiShellMenu } from './shell-menu'
import { bootstrapShellAuth } from './shell-auth'
import './styles/index.css'

void bootstrapShellAuth(
  (window as unknown as {
    __mochi_shell?: { userName?: string; menuToken?: string }
  }).__mochi_shell
)

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
