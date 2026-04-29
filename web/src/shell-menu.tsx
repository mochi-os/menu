import { useState, useEffect, useSyncExternalStore } from 'react'
import { usePushRegistration } from './use-push-registration'
import { useMenuNotifications } from './use-menu-notifications'
import { useSubscribeNotifications } from './use-subscribe-notifications'
import { usePermissionRequest } from './use-permission-request'
import { useShellFetch } from './use-shell-fetch'
import {
  Bell,
  Check,
  ExternalLink,
  LogOut,
  Menu,

} from 'lucide-react'
import {
  cn,
  useAuthStore,
  useScreenSize,
  useDialogState,
  EntityAvatar,
  SignOutDialog,
  shellNavigateExternal,
  useFormat,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  ScrollArea,
} from '@mochi/web'
import type { Notification } from '@mochi/web'

function MochiLogo() {
  return <img src='/images/logo-header.svg' alt='Mochi' className='h-6 w-6' />
}

function NotificationItem({ notification, onClick, onMiddleClick }: {
  notification: Notification
  onClick?: (notification: Notification) => void
  onMiddleClick?: (notification: Notification) => void
}) {
  const { formatTimestamp } = useFormat()
  const isUnread = notification.read === 0

  return (
    <button
      type='button'
      onClick={() => onClick?.(notification)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onMiddleClick?.(notification)
        }
      }}
      className={cn(
        'group flex w-full items-start gap-3 px-4 py-2 text-left transition-colors hover:bg-muted/50',
        isUnread ? 'bg-muted/30' : 'bg-transparent'
      )}
    >
      <div
        className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full transition-colors',
          isUnread
            ? 'bg-primary'
            : 'bg-transparent group-hover:bg-muted-foreground/20'
        )}
      />
      <div className='flex-1 min-w-0 space-y-0.5'>
        <p
          className={cn(
            'text-sm leading-snug',
            isUnread ? 'font-medium text-foreground' : 'text-muted-foreground'
          )}
        >
          {notification.content}
        </p>
        <p className='text-[11px] text-muted-foreground/70'>
          {formatTimestamp(notification.created)}
        </p>
      </div>
    </button>
  )
}

// Observe the data-sidebar attribute on #menu, set by shell.js
function useSidebarState(): 'expanded' | 'collapsed' {
  return useSyncExternalStore(
    (cb) => {
      const el = document.getElementById('menu')
      if (!el) return () => {}
      const observer = new MutationObserver(cb)
      observer.observe(el, { attributes: true, attributeFilter: ['data-sidebar'] })
      return () => observer.disconnect()
    },
    () => {
      const el = document.getElementById('menu')
      return (el?.getAttribute('data-sidebar') as 'expanded' | 'collapsed') || 'expanded'
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
      if (!el) return () => {}
      const observer = new MutationObserver(cb)
      observer.observe(el, { attributes: true, attributeFilter: ['data-sidebar-present'] })
      return () => observer.disconnect()
    },
    () => {
      const el = document.getElementById('menu')
      return el?.getAttribute('data-sidebar-present') === 'true'
    }
  )
}

export function MochiShellMenu() {
  usePushRegistration()
  useShellFetch()
  const { dialog: subscribeDialog } = useSubscribeNotifications()
  const { dialog: permissionDialog } = usePermissionRequest()
  const [signOutOpen, setSignOutOpen] = useDialogState()
  const [menuOpen, setMenuOpen] = useState(false)
  const { isDesktop } = useScreenSize()
  const sidebarState = useSidebarState()
  const sidebarPresent = useSidebarPresent()
  const isCollapsed = sidebarPresent && sidebarState === 'collapsed'
  const { notifications, markAsRead, markAllAsRead } = useMenuNotifications()

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
  const unreadNotifications = notifications.filter((n: Notification) => n.read === 0)
  const unreadCount = unreadNotifications.length

  // Publish count to shell.js so it can prefix "(N)" onto the tab title.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('mochi-notification-count', { detail: unreadCount }))
  }, [unreadCount])

  const handleNotificationClick = (notification: Notification) => {
    console.log('[notif-click]', { id: notification.id, read: notification.read, link: notification.link })
    if (notification.read === 0) {
      markAsRead(notification.id)
    }
    if (notification.link) {
      setMenuOpen(false)
      shellNavigateExternal(notification.link)
    }
  }

  const handleNotificationMiddleClick = (notification: Notification) => {
    if (notification.read === 0) {
      markAsRead(notification.id)
    }
    if (notification.link) {
      window.open(notification.link, '_blank')
    }
    if (unreadCount === 1) {
      setMenuOpen(false)
    }
  }

  const trigger = (
    <button className='relative rounded p-1 hover:bg-interactive-hover active:bg-interactive-active'>
      <EntityAvatar fingerprint={identity || undefined} name={name} size={24} />
      {unreadCount > 0 && (
        <span className='absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white'>
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  )

  const userSection = (
    <div className='flex items-center justify-between px-4 py-2.5'>
      <div className='flex items-center gap-2'>
        <EntityAvatar fingerprint={identity || undefined} name={name} size={32} />
        <span className='text-sm font-semibold'>{name || 'User'}</span>
      </div>
      <div className='flex items-center gap-1 ml-4'>
        <button
          onClick={() => { setMenuOpen(false); setTimeout(() => setSignOutOpen(true), 150) }}
          className='flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-interactive-hover active:bg-interactive-active'
        >
          <LogOut className='size-4' />
        </button>
      </div>
    </div>
  )

  const notificationsHeader = (
    <div className='flex items-center justify-between border-b bg-muted/30 px-4 py-2.5'>
      <span className='font-semibold text-sm'>
        Notifications{unreadCount > 0 && ` (${unreadCount})`}
      </span>
      <div className='flex items-center gap-1'>
        {unreadCount > 0 && (
          <button
            onClick={() => { markAllAsRead(); setMenuOpen(false) }}
            className='flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-interactive-hover active:bg-interactive-active'
            title='Mark all as read'
          >
            <Check className='size-4' />
          </button>
        )}
        <a
          href='/notifications/'
          onClick={() => setMenuOpen(false)}
          className='flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-interactive-hover active:bg-interactive-active'
          title='View all'
        >
          <ExternalLink className='size-4' />
        </a>
      </div>
    </div>
  )

  const notificationsList = (
    <ScrollArea className='min-h-0 flex-1 overflow-y-scroll'>
      <div className='flex flex-col'>
        {unreadNotifications.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-8 text-center px-4'>
            <Bell className='size-8 text-muted-foreground/20 mb-3' />
            <p className='text-sm font-medium text-foreground'>
              No unread notifications
            </p>
          </div>
        ) : (
          <div className='divide-y divide-border/40'>
            {unreadNotifications.map((notification: Notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onClick={handleNotificationClick}
                onMiddleClick={handleNotificationMiddleClick}
              />
            ))}
          </div>
        )}
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

  return (
    <>
      <div className={cn(
        'flex items-center gap-2 p-2',
        isCollapsed && 'flex-col'
      )}>
        {!isDesktop && (
          <button
            type='button'
            onClick={() => window.dispatchEvent(new CustomEvent('mochi-sidebar-toggle'))}
            className={cn(
              'rounded p-1 hover:bg-interactive-hover active:bg-interactive-active',
              !sidebarPresent && 'invisible'
            )}
            aria-label='Toggle navigation'
            tabIndex={sidebarPresent ? 0 : -1}
          >
            <Menu className='size-5' />
          </button>
        )}
        <a href='/' title='Home'>
          <MochiLogo />
        </a>

        {isDesktop ? (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent
              align='start'
              sideOffset={8}
              className='flex w-80 max-h-[var(--radix-popover-content-available-height)] flex-col p-0 overflow-hidden shadow-lg border-border sm:w-96'
            >
              {menuContent}
            </PopoverContent>
          </Popover>
        ) : (
          <Drawer open={menuOpen} onOpenChange={setMenuOpen} direction='top'>
            <DrawerTrigger asChild>{trigger}</DrawerTrigger>
            <DrawerContent>
              <DrawerHeader className='sr-only'>
                <DrawerTitle>Menu</DrawerTitle>
              </DrawerHeader>
              {menuContent}
            </DrawerContent>
          </Drawer>
        )}
      </div>

      <SignOutDialog open={!!signOutOpen} onOpenChange={setSignOutOpen} />
      {subscribeDialog}
      {permissionDialog}
    </>
  )
}
