import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, createQueryClient } from '@mochi/web'
import { MochiShellMenu } from './shell-menu'
import { bootstrapShellAuth } from './shell-auth'
import './styles/index.css'

async function init() {
  const shellReady = (window as unknown as {
    __mochi_shell_ready?: Promise<{ menuToken?: string }>
  }).__mochi_shell_ready

  const config = shellReady ? await shellReady : undefined
  await bootstrapShellAuth(config)

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
}

void init()
