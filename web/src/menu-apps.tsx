// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The app grid in the shell menu, fed by the menu's own apps action.
import type { CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  getErrorMessage,
  naturalCompare,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@mochi/web'
import { menuFetch } from './menu-api'

interface MenuApp {
  id: string
  path: string
  name: string
  file: string
  link: string
  development: boolean
  highlight?: boolean
}

interface AppsResponse {
  icons: MenuApp[]
  icon_mask?: string
  icon_background?: string
}

// Theme icon masks, as the home screen draws them.
const maskBorderRadius: Record<string, string> = {
  circle: '50%',
  square: '0',
  rounded: '22%',
  squircle: '28%',
}

export function useMenuApps() {
  return useQuery({
    queryKey: ['menu', 'apps'],
    queryFn: () =>
      menuFetch<{ data: AppsResponse }>('-/apps').then(
        (response) => response.data
      ),
    staleTime: 5 * 60 * 1000,
  })
}

function AppLink({
  app,
  mask,
  background,
}: {
  app: MenuApp
  mask?: string
  background?: string
}) {
  // Home is served at the root, so its path and link are empty; joining them
  // blindly would give a protocol-relative //images/... URL.
  const url = `url(/${app.path ? `${app.path}/` : ''}${app.file})`
  const glyph = {
    maskImage: url,
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskImage: url,
    WebkitMaskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
  } as CSSProperties
  const radius = mask ? maskBorderRadius[mask] : undefined
  // Icons alone: the name is the link's label and its tooltip.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={app.link ? `/${app.link}/` : '/'}
          aria-label={app.name}
          className='group hover:bg-hover active:bg-interactive-active focus-visible:ring-ring flex h-11 min-w-0 items-center justify-center rounded-md transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none'
        >
          <span className='relative flex size-8 items-center justify-center'>
            {radius !== undefined ? (
              <span
                className='flex size-8 items-center justify-center'
                style={{
                  backgroundColor: background || 'var(--primary)',
                  borderRadius: radius,
                }}
              >
                <span
                  className='size-5 bg-white'
                  style={glyph}
                  aria-hidden='true'
                />
              </span>
            ) : (
              <span
                className='bg-primary/70 group-hover:bg-primary size-6 transition-colors duration-150'
                style={glyph}
                aria-hidden='true'
              />
            )}
            {app.highlight && (
              <span
                className='absolute -top-0.5 -right-0.5 flex size-2.5'
                aria-hidden='true'
              >
                <span className='bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-75' />
                <span className='bg-primary relative inline-flex size-2.5 rounded-full' />
              </span>
            )}
          </span>
        </a>
      </TooltipTrigger>
      <TooltipContent>{app.name}</TooltipContent>
    </Tooltip>
  )
}

const grid = 'grid grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-1'

export function MenuApps({ query }: { query: ReturnType<typeof useMenuApps> }) {
  const { t } = useLingui()
  const { data, isLoading, isError, error } = query

  if (isLoading) {
    return (
      <div className={`${grid} p-2`}>
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className='flex h-11 items-center justify-center'>
            <Skeleton className='size-8 rounded-md' />
          </div>
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <p className='text-muted-foreground px-4 py-3 text-sm'>
        {getErrorMessage(error, t`Failed to load apps`)}
      </p>
    )
  }

  // Consumer-side sort: core's ordering is accent- and numeric-blind.
  const apps = [...(data?.icons ?? [])].sort((a, b) =>
    naturalCompare(a.name, b.name)
  )
  if (apps.length === 0) return null
  const installed = apps.filter((app) => !app.development)
  const development = apps.filter((app) => app.development)
  const link = (app: MenuApp) => (
    <AppLink
      key={`${app.id}:${app.path}:${app.file}`}
      app={app}
      mask={data?.icon_mask}
      background={data?.icon_background}
    />
  )

  return (
    <div className='p-2'>
      {installed.length > 0 && (
        <div className={grid}>{installed.map(link)}</div>
      )}
      {development.length > 0 && (
        <>
          <div className='my-2 flex items-center gap-3 px-2'>
            <div className='bg-border h-px flex-1' />
            <h2 className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>
              <Trans>Development</Trans>
            </h2>
            <div className='bg-border h-px flex-1' />
          </div>
          <div className={grid}>{development.map(link)}</div>
        </>
      )}
    </div>
  )
}
