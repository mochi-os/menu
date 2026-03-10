import { useState, useEffect, useSyncExternalStore } from 'react'
import { usePushRegistration } from './use-push-registration'
import {
  Bell,
  Check,
  CircleUser,
  ExternalLink,
  LogOut,

} from 'lucide-react'
import {
  cn,
  useNotifications,
  useAuthStore,
  useScreenSize,
  useDialogState,
  SignOutDialog,
  shellNavigateExternal,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  ScrollArea,
} from '@mochi/common'
import type { Notification } from '@mochi/common'

function MochiLogo() {
  return <img src='/images/logo-header.svg' alt='Mochi' className='h-6 w-6' />
}

function formatTimestamp(timestamp: number): string {
  const now = Date.now() / 1000
  const diff = now - timestamp

  if (diff < 60) return 'Just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`

  const date = new Date(timestamp * 1000)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function NotificationItem({ notification, onClick }: {
  notification: Notification
  onClick?: (notification: Notification) => void
}) {
  const isUnread = notification.read === 0

  return (
    <button
      type='button'
      onClick={() => onClick?.(notification)}
      className={cn(
        'group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50',
        isUnread ? 'bg-muted/30' : 'bg-transparent'
      )}
    >
      <div
        className={cn(
          'mt-1.5 size-2.5 shrink-0 rounded-full transition-colors',
          isUnread
            ? 'bg-primary'
            : 'bg-transparent group-hover:bg-muted-foreground/20'
        )}
      />
      <div className='flex-1 min-w-0 space-y-1'>
        <p
          className={cn(
            'text-sm leading-snug',
            isUnread ? 'font-medium text-foreground' : 'text-muted-foreground'
          )}
        >
          {notification.content}
          {notification.count > 1 && (
            <span className='ml-1 inline-flex items-center justify-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium'>
              {notification.count}
            </span>
          )}
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

export function MochiShellMenu() {
  usePushRegistration()
  const [signOutOpen, setSignOutOpen] = useDialogState()
  const [menuOpen, setMenuOpen] = useState(false)
  const { isDesktop } = useScreenSize()
  const sidebarState = useSidebarState()
  const isCollapsed = sidebarState === 'collapsed'
  const { notifications, markAsRead, markAllAsRead } = useNotifications()

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
  const unreadNotifications = notifications.filter((n: Notification) => n.read === 0)
  const unreadCount = unreadNotifications.length

  const handleNotificationClick = (notification: Notification) => {
    if (notification.read === 0) {
      markAsRead(notification.id)
    }
    if (notification.link) {
      setMenuOpen(false)
      shellNavigateExternal(notification.link)
    }
  }

  const trigger = (
    <button className='relative rounded p-1 hover:bg-interactive-hover active:bg-interactive-active'>
      <CircleUser className='size-6 text-muted-foreground' />
      {unreadCount > 0 && (
        <span className='absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white'>
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  )

  const userSection = (
    <div className='flex items-center justify-between px-4 py-2.5'>
      <span className='text-sm font-semibold'>{name || 'User'}</span>
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
            onClick={() => markAllAsRead()}
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
    <ScrollArea className='max-h-[min(420px,60vh)] overflow-y-scroll'>
      <div className='flex flex-col'>
        {unreadNotifications.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-8 text-center px-4'>
            <Bell className='size-8 text-muted-foreground/20 mb-3' />
            <p className='text-sm font-medium text-foreground'>
              No new notifications
            </p>
          </div>
        ) : (
          <div className='divide-y divide-border/40'>
            {unreadNotifications.map((notification: Notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onClick={handleNotificationClick}
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
        <a href='/' title='Home'>
          <MochiLogo />
        </a>

        {isDesktop ? (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent
              align='start'
              sideOffset={8}
              className='w-80 p-0 overflow-hidden shadow-lg border-border sm:w-96'
            >
              {menuContent}
            </PopoverContent>
          </Popover>
        ) : (
          <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
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
    </>
  )
}
