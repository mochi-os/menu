// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useState, useEffect, useSyncExternalStore } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { usePushRegistration } from './use-push-registration'
import { useMenuNotifications } from './use-menu-notifications'
import { usePermissionRequest } from './use-permission-request'
import { ChromeBoundary } from './chrome-boundary'
import {
  Check,
  ExternalLink,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import {
  cn,
  useAuthStore,
  useScreenSize,
  useDialogState,
  EntityAvatar,
  NotificationCategoryButton,
  NotificationList,
  SignOutDialog,
  shellNavigateExternal,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  type Notification,
} from '@mochi/web'
import { useMenuCategories } from './use-menu-categories'

function MochiLogo() {
  return <img src='/menu/images/logo-header.png' alt='Mochi' className='h-7 w-7' />
}

// Notification links are app-authored: only http(s) may go to window.open,
// since a javascript:/data: URL would run with access to window.opener (the
// shell).
function isSafeLink(link: string): boolean {
  try {
    const url = new URL(link, window.location.origin)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// Notification links are app-authored, so the menu — which runs in the trusted
// top window — must not let one steer the whole tab off-origin (a phishing
// vector). Same-origin links navigate within the shell; anything else is opened
// in a new tab instead of replacing the shell.
function isSameOriginLink(link: string): boolean {
  try {
    return new URL(link, window.location.origin).origin === window.location.origin
  } catch {
    return false
  }
}

// Observe the data-sidebar shell.js
function useSidebarState(): 'expanded' | 'collapsed' {
  return useSyncExternalStore(
    (cb) => {
      const el = document.getElementById('menu')
      if (!el) return () => { }
      const observer = new MutationObserver(cb)
      observer.observe(el, {
        attributes: true,
        attributeFilter: ['data-sidebar'],
      })
      return () => observer.disconnect()
    },
    () => {
      const el = document.getElementById('menu')
      return (
        (el?.getAttribute('data-sidebar') as 'expanded' | 'collapsed') ||
        'expanded'
      )
    }
  )
}

// Observe data-app on #menu — set by shell.js to the current app's path segment.
// The home app has path "" (root "/").
function useCurrentApp(): string {
  return useSyncExternalStore(
    (cb) => {
      const el = document.getElementById('menu')
      if (!el) return () => { }
      const observer = new MutationObserver(cb)
      observer.observe(el, {
        attributes: true,
        attributeFilter: ['data-app'],
      })
      return () => observer.disconnect()
    },
    () => {
      const el = document.getElementById('menu')
      return el?.getAttribute('data-app') ?? ''
    }
  )
}

// Observe data-sidebar-present on #menu. True when the currently loaded app
// has a sidebar; when false, the menu should ignore the persisted collapse
// state and render horizontally (e.g. on the home page).
function useSidebarPresent(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const el = document.getElementById('menu')
      if (!el) return () => { }
      const observer = new MutationObserver(cb)
      observer.observe(el, {
        attributes: true,
        attributeFilter: ['data-sidebar-present'],
      })
      return () => observer.disconnect()
    },
    () => {
      const el = document.getElementById('menu')
      return el?.getAttribute('data-sidebar-present') === 'true'
    }
  )
}

export function MochiShellMenu() {
  const { t } = useLingui()
  usePushRegistration()
  const { dialog: permissionDialog } = usePermissionRequest()
  const [signOutOpen, setSignOutOpen] = useDialogState()
  const [menuOpen, setMenuOpen] = useState(false)
  const { isDesktop } = useScreenSize()
  const isCompact = !isDesktop
  const sidebarState = useSidebarState()
  const sidebarPresent = useSidebarPresent()
  const isCollapsed = sidebarPresent && sidebarState === 'collapsed'
  const currentApp = useCurrentApp()
  const isHome = currentApp === ''
  const { notifications, isLoading, isError, markAsRead, markAllAsRead } =
    useMenuNotifications()

  // Close menu on Escape
  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  // Block iframe clicks while menu is open — iframe swallows pointer events
  // so Radix can't detect outside clicks. An overlay captures them instead.
  useEffect(() => {
    if (!menuOpen) return
    const container = document.getElementById('app-container')
    if (!container) return
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:absolute;inset:0;z-index:1;cursor:default'
    overlay.addEventListener('pointerdown', () => setMenuOpen(false))
    container.appendChild(overlay)
    return () => overlay.remove()
  }, [menuOpen])

  const name = useAuthStore((s) => s.name)
  const identity = useAuthStore((s) => s.identity)
  const avatar = useAuthStore((s) => s.avatar)
  // Own avatar and accent through the menu's proxy, never the people app.
  const personAsset = (asset: 'avatar' | 'style', version?: string | null) =>
    identity ? `/menu/-/person/asset/${asset}${version ? `?version=${encodeURIComponent(version)}` : ''}` : undefined
  const categoryPicker = useMenuCategories()
  const unreadNotifications = notifications.filter((n: Notification) => n.read === 0)
  const unreadCount = unreadNotifications.length

  // 'avatar-set' from the people app: the avatar URL is cached for five
  // minutes, so re-render with the new version token. Only the loaded app
  // iframe may drive it, and only for the signed-in identity.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'avatar-set') return
      const appFrame = document.getElementById('app-frame') as HTMLIFrameElement | null
      if (!appFrame || event.source !== appFrame.contentWindow) return
      if (typeof data.version !== 'string' || data.version.length > 64) return
      const store = useAuthStore.getState()
      if (data.person !== store.identity) return
      store.setAvatar(data.version)
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Publish count to shell.js so it can prefix "(N)" onto the tab title.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('mochi-notification-count', { detail: unreadCount }))
  }, [unreadCount])

  const handleNotificationClick = (notification: Notification) => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[notif-click]', { id: notification.id, read: notification.read, link: notification.link })
    }
    if (notification.read === 0) {
      markAsRead(notification.id)
    }
    if (notification.link) {
      setMenuOpen(false)
      if (isSameOriginLink(notification.link)) {
        shellNavigateExternal(notification.link)
      } else if (isSafeLink(notification.link)) {
        // Off-origin http(s) target — open in a new tab rather than navigating
        // the shell away; noopener stops the opened page reaching back.
        window.open(notification.link, '_blank', 'noopener,noreferrer')
      }
      // Any other scheme (javascript:/data:) is ignored.
    }
  }

  const handleNotificationMiddleClick = (notification: Notification) => {
    if (notification.read === 0) {
      markAsRead(notification.id)
    }
    if (notification.link && isSafeLink(notification.link)) {
      // Not the two-branch form left click uses: a new tab is a top-level
      // document GET without _shell=1, which core answers with the shell
      // (shell_wrap_candidate), so a same-origin link already lands inside it.
      window.open(notification.link, '_blank', 'noopener,noreferrer')
    }
    if (unreadCount === 1) {
      setMenuOpen(false)
    }
  }

  const handleSidebarToggle = () => {
    window.dispatchEvent(new CustomEvent('mochi-sidebar-toggle'))
  }

  const trigger = (
    <button
      type='button'
      aria-label={t`Open menu`}
      className='relative flex size-9 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
    >
      <EntityAvatar src={personAsset('avatar', avatar)} styleUrl={personAsset('style')} seed={identity || undefined} name={name} size="sm" />
      {unreadCount > 0 && (
        <span className='absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-notification px-1 text-[10px] font-medium text-notification-foreground'>
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  )

  const userSection = (
    <div className='flex items-center justify-between px-4 py-2.5'>
      <div className='flex items-center gap-2'>
        <EntityAvatar src={personAsset('avatar', avatar)} styleUrl={personAsset('style')} seed={identity || undefined} name={name} size="md" />
        <span className='text-sm font-semibold'>{name || t`User`}</span>
      </div>
      <div className='flex items-center gap-1 ms-4'>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => { setMenuOpen(false); setTimeout(() => setSignOutOpen(true), 150) }}
              aria-label={t`Log out`}
              className='flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-hover active:bg-interactive-active'
            >
              <LogOut className='size-4' />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t`Log out`}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )

  const notificationsHeader = (
    <div className='flex items-center justify-between border-b bg-muted/30 px-4 py-2.5'>
      <span className='font-semibold text-sm'>
        <Trans>Notifications</Trans>{unreadCount > 0 && ` (${unreadCount})`}
      </span>
      <div className='flex items-center gap-1'>
        {unreadCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => { markAllAsRead(); setMenuOpen(false) }}
                aria-label={t`Mark all as read`}
                className='flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-hover active:bg-interactive-active'
              >
                <Check className='size-4' />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t`Mark all as read`}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href='/notifications/'
              onClick={() => setMenuOpen(false)}
              aria-label={t`View all`}
              className='flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-hover active:bg-interactive-active'
            >
              <ExternalLink className='size-4' />
            </a>
          </TooltipTrigger>
          <TooltipContent>{t`View all`}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )

  const notificationsList = (
    <ScrollArea className='min-h-0 flex-1 overflow-y-scroll'>
      <div className='flex flex-col'>
        <ChromeBoundary>
        <NotificationList
          notifications={unreadNotifications}
          isLoading={isLoading}
          isError={isError}
          onClick={handleNotificationClick}
          onMiddleClick={handleNotificationMiddleClick}
          actions={(notification: Notification) => (
            <NotificationCategoryButton
              categories={categoryPicker.categories}
              topic={categoryPicker.topic}
              saving={categoryPicker.saving}
              open={
                categoryPicker.openKey ===
                categoryPicker.keyFor(notification.app, notification.topic, notification.object)
              }
              onOpenChange={(next) => {
                if (next) {
                  void categoryPicker.open(
                    notification.app,
                    notification.topic,
                    notification.object
                  )
                } else {
                  categoryPicker.close()
                }
              }}
              onCategoryChange={categoryPicker.changeCategory}
              className='mt-0.5 shrink-0'
            />
          )}
          />
        </ChromeBoundary>
      </div>
    </ScrollArea>
  )

  const menuContent = (
    <>
      {userSection}
      {notificationsHeader}
      {notificationsList}
    </>
  )

  const menuControl = (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t`Open menu`}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align='start'
        sideOffset={8}
        className='flex w-80 max-h-(--radix-popover-content-available-height) flex-col p-0 overflow-hidden shadow-lg border-border sm:w-96'
      >
        {menuContent}
      </PopoverContent>
    </Popover>
  )

  if (isCompact) {
    return (
      <>
        <header className='flex h-12 w-full items-center gap-1 border-b bg-background px-2'>
          {sidebarPresent && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  aria-label={sidebarState === 'expanded' ? t`Close navigation` : t`Open navigation`}
                  onClick={handleSidebarToggle}
                  className='flex size-10 shrink-0 items-center justify-center rounded-md transition-colors duration-150 hover:bg-hover active:bg-interactive-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                >
                  {sidebarState === 'expanded' ? <PanelLeftClose className='size-5' /> : <PanelLeftOpen className='size-5' />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{sidebarState === 'expanded' ? t`Close navigation` : t`Open navigation`}</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href='/'
                aria-label={t`Home`}
                className='flex size-10 shrink-0 items-center justify-center rounded-md transition-colors duration-150 hover:bg-hover active:bg-interactive-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              >
                <MochiLogo />
              </a>
            </TooltipTrigger>
            <TooltipContent>{t`Home`}</TooltipContent>
          </Tooltip>

          <div className='min-w-0 flex-1 flex items-center justify-center'>
            {isHome && (
              /* jsx-text-ok: brand wordmark, verbatim in every locale */
              <span className='sm:hidden text-[1.5rem] font-light tracking-[3px] bg-linear-to-br from-foreground to-muted-foreground/30 bg-clip-text text-transparent select-none'>mochi</span>
            )}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type='button'
                aria-label={t`Open menu`}
                onClick={() => setMenuOpen(true)}
                className='relative flex size-9 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              >
                <EntityAvatar src={personAsset('avatar', avatar)} styleUrl={personAsset('style')} seed={identity || undefined} name={name} size="sm" />
                {unreadCount > 0 && (
                  <span className='absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-notification px-1 text-[10px] font-medium text-notification-foreground'>
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>{t`Open menu`}</TooltipContent>
          </Tooltip>
        </header>

        {/* Custom bottom sheet — renders inside #menu (position:fixed), no Radix Dialog,
            no react-remove-scroll, no body style changes that shift the app iframe */}
        <div
          aria-hidden='true'
          className={cn(
            'fixed inset-0 bg-black/50 transition-opacity duration-300',
            menuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
          )}
          onClick={() => setMenuOpen(false)}
        />
        <div
          role='dialog'
          aria-label={t`Menu`}
          aria-modal='true'
          className={cn(
            'fixed bottom-0 inset-x-0 bg-background rounded-t-lg border-t flex flex-col max-h-[80dvh] overflow-hidden transition-transform duration-300 ease-out',
            menuOpen ? 'translate-y-0' : 'translate-y-full pointer-events-none'
          )}
        >
          <div className='mx-auto mt-4 mb-1 h-2 w-25 shrink-0 rounded-full bg-muted' />
          {menuContent}
        </div>

        <SignOutDialog open={!!signOutOpen} onOpenChange={setSignOutOpen} />
        {permissionDialog}
      </>
    )
  }

  return (
    <>
      {/* Desktop menu overlay: horizontal, stacking vertically only when the user collapsed an existing
          sidebar. No-sidebar apps stay horizontal; their `md:ps-24` padding clears the overlay. */}
      <div className={cn(
        'flex items-center gap-2 p-2',
        isCollapsed && 'flex-col'
      )}>
        <Tooltip>
          <TooltipTrigger asChild>
            <a href='/' aria-label={t`Home`}>
              <MochiLogo />
            </a>
          </TooltipTrigger>
          <TooltipContent>{t`Home`}</TooltipContent>
        </Tooltip>

        {menuControl}
      </div>

      <SignOutDialog open={!!signOutOpen} onOpenChange={setSignOutOpen} />
      {permissionDialog}
    </>
  )
}
