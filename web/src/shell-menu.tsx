import { useState } from 'react'
import {
  CircleUser,
  LogOut,
  Settings,
} from 'lucide-react'
import {
  useNotifications,
  useAuthStore,
  useScreenSize,
  useDialogState,
  NotificationsDropdown,
  SignOutDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@mochi/common'

function MochiLogo() {
  return <img src='/images/logo-header.svg' alt='Mochi' className='h-6 w-6' />
}

export function MochiShellMenu() {
  const [signOutOpen, setSignOutOpen] = useDialogState()
  const [menuOpen, setMenuOpen] = useState(false)
  const { isMobile } = useScreenSize()
  const { notifications, markAsRead, markAllAsRead } = useNotifications()

  const name = useAuthStore((s) => s.name)

  const handleNotificationClick = (notification: { id: string; link: string; read: number }) => {
    if (notification.read === 0) {
      markAsRead(notification.id)
    }
    if (notification.link) {
      setMenuOpen(false)
      window.location.href = notification.link
    }
  }

  const menuContent = (
    <DropdownMenuLabel className='p-0 font-normal'>
      <div className='flex items-center justify-between px-2 py-1.5'>
        <div className='grid text-sm'>
          <span className='font-semibold'>{name || 'User'}</span>
        </div>
        <div className='flex items-center gap-1 ml-4'>
          <a
            href='/settings'
            className='flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-interactive-hover active:bg-interactive-active'
          >
            <Settings className='size-4' />
          </a>
          <button
            onClick={() => setSignOutOpen(true)}
            className='flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-interactive-hover active:bg-interactive-active'
          >
            <LogOut className='size-4' />
          </button>
        </div>
      </div>
    </DropdownMenuLabel>
  )

  const userTrigger = (
    <button className='rounded p-1 hover:bg-interactive-hover active:bg-interactive-active'>
      <CircleUser className='size-6 text-muted-foreground' />
    </button>
  )

  return (
    <>
      <div className='flex h-10 items-center gap-2 border-b bg-background px-2'>
        <a href='/' title='Home'>
          <MochiLogo />
        </a>

        <div className='flex-1' />

        {/* Notifications dropdown */}
        <NotificationsDropdown
          notifications={notifications}
          notificationsUrl='/notifications/'
          onMarkAllAsRead={markAllAsRead}
          onNotificationClick={handleNotificationClick}
        />

        {/* User menu */}
        {isMobile ? (
          <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
            <DrawerTrigger asChild>{userTrigger}</DrawerTrigger>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle className='sr-only'>Menu</DrawerTitle>
              </DrawerHeader>
              <div className='px-4 pb-4'>{menuContent}</div>
            </DrawerContent>
          </Drawer>
        ) : (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>{userTrigger}</DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='min-w-72'>
              {menuContent}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <SignOutDialog open={!!signOutOpen} onOpenChange={setSignOutOpen} />
    </>
  )
}
