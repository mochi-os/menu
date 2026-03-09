import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, createQueryClient } from '@mochi/common'
import { MochiShellMenu } from './shell-menu'
import './styles/index.css'

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
