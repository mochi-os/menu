import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, createQueryClient, I18nProvider, type Catalogs } from '@mochi/web'
import { Toaster } from '@mochi/web/components/ui/sonner'
import { MochiShellMenu } from './shell-menu'
import { bootstrapShellAuth } from './shell-auth'
import './styles/index.css'

// Lingui catalogs bundled by @lingui/vite-plugin (compiled from
// src/locales/<lang>/messages.po on the fly).
const catalogs: Catalogs = {
  en: () => import('./locales/en/messages.po'),
  'en-us': () => import('./locales/en-US/messages.po'),
  fr: () => import('./locales/fr/messages.po'),
  ja: () => import('./locales/ja/messages.po'),

  ar: () => import('./locales/ar/messages.po'),
}

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
        <I18nProvider catalogs={catalogs}>
          <ThemeProvider>
            <MochiShellMenu />
            <Toaster duration={5000} />
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}

void init()
