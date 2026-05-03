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
  'en-us': () => import('./locales/en-us/messages.po'),
  fr: () => import('./locales/fr/messages.po'),
  ja: () => import('./locales/ja/messages.po'),



  af: () => import('./locales/af/messages.po'),
  'nl-be': () => import('./locales/nl-be/messages.po'),
  ms: () => import('./locales/ms/messages.po'),
  is: () => import('./locales/is/messages.po'),
  nb: () => import('./locales/nb/messages.po'),
  fi: () => import('./locales/fi/messages.po'),
  da: () => import('./locales/da/messages.po'),
  hu: () => import('./locales/hu/messages.po'),
  cs: () => import('./locales/cs/messages.po'),
  uk: () => import('./locales/uk/messages.po'),
  ru: () => import('./locales/ru/messages.po'),
  el: () => import('./locales/el/messages.po'),
  vi: () => import('./locales/vi/messages.po'),
  ur: () => import('./locales/ur/messages.po'),
  hi: () => import('./locales/hi/messages.po'),
  it: () => import('./locales/it/messages.po'),
  he: () => import('./locales/he/messages.po'),
  pl: () => import('./locales/pl/messages.po'),
  nl: () => import('./locales/nl/messages.po'),
  sv: () => import('./locales/sv/messages.po'),
  de: () => import('./locales/de/messages.po'),
  'pt-br': () => import('./locales/pt-br/messages.po'),
  pt: () => import('./locales/pt/messages.po'),
  'es-419': () => import('./locales/es-419/messages.po'),

  es: () => import('./locales/es/messages.po'),
  tl: () => import('./locales/tl/messages.po'),
  th: () => import('./locales/th/messages.po'),
  id: () => import('./locales/id/messages.po'),
  ko: () => import('./locales/ko/messages.po'),
  'zh-hant': () => import('./locales/zh-hant/messages.po'),
  'zh-hans': () => import('./locales/zh-hans/messages.po'),
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
