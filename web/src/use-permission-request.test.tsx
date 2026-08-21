// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { useAuthStore } from '@mochi/web'
import { usePermissionRequest } from './use-permission-request'

// <Trans> needs an active i18n; an empty catalog renders the source message.
i18n.loadAndActivate({ locale: 'en', messages: {} })

// Mock fetch globally
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

// Permission names and levels are owned by core and resolved via
// /menu/-/permissions/name; app display names via /menu/-/permissions/application.
// The dialog fires both lookups as soon as a request arrives, then issues the
// grant request on Allow. Route all three by URL so tests can assert each.
const NAMES: Record<string, { name: string; restricted?: boolean }> = {
  'accounts/read': { name: 'Read connected accounts' },
  'groups/write': { name: 'Change groups' },
  'users/read': { name: 'Read user data', restricted: true },
  'url:api.github.com': { name: 'Access api.github.com' },
  microphone: { name: 'Use the microphone' },
}

const APPS: Record<string, string> = {
  feeds: 'Feeds',
  wikis: 'Wikis',
  chat: 'Chat',
  // A production install is keyed by its entity id, not a readable path.
  '12254aHfG39Lqrizh': 'Repositories',
}

function nameResponse(opts: { body?: string } | undefined) {
  const code = new URLSearchParams(opts?.body ?? '').get('permission') ?? ''
  const entry = NAMES[code]
  return {
    ok: true,
    json: async () => ({
      data: { name: entry?.name ?? code, restricted: !!entry?.restricted },
    }),
  }
}

function applicationResponse(opts: { body?: string } | undefined) {
  const id = new URLSearchParams(opts?.body ?? '').get('app') ?? ''
  const name = APPS[id]
  if (!name) return { ok: false, json: async () => ({ error: 'Not found' }) }
  return { ok: true, json: async () => ({ data: { name } }) }
}

// Default routing: name lookups resolve to the catalog name, grant succeeds.
// Individual tests override grant behaviour by re-implementing the router.
function defaultRouter(grant: () => unknown = () => ({ ok: true, json: async () => ({ data: { status: 'granted' } }) })) {
  return (url: string, opts?: { body?: string }) => {
    if (typeof url === 'string' && url.endsWith('/permissions/name')) {
      return Promise.resolve(nameResponse(opts))
    }
    if (typeof url === 'string' && url.endsWith('/permissions/application')) {
      return Promise.resolve(applicationResponse(opts))
    }
    return Promise.resolve(grant())
  }
}

// The dialog reads the menu token from useAuthStore (getMenuToken).
// The shell hosts exactly one app iframe (#app-frame) and exposes its
// server-resolved id as window.__mochi_shell.appId — the dialog derives the app
// from those, never the self-asserted data.app, so the tests set both up.
let appFrame: HTMLIFrameElement
beforeEach(() => {
  useAuthStore.setState({ token: 'test-token' })
  mockFetch.mockReset()
  mockFetch.mockImplementation(defaultRouter())
  appFrame = document.createElement('iframe')
  appFrame.id = 'app-frame'
  document.body.appendChild(appFrame)
})

afterEach(() => {
  appFrame.remove()
  delete (window as unknown as { __mochi_shell?: unknown }).__mochi_shell
})

// Test wrapper that renders the hook's dialog
function TestComponent() {
  const { dialog } = usePermissionRequest()
  return (
    <I18nProvider i18n={i18n}>
      <div>{dialog}</div>
    </I18nProvider>
  )
}

function sendPermissionRequest(opts: {
  id: number
  app: string // the authoritative loaded app — set as __mochi_shell.appId
  permission: string
  // Self-asserted flag still sent by the iframe shim; the dialog must ignore
  // it and use the server-resolved level from the permissions/name lookup.
  restricted: boolean
  spoofApp?: string // an attacker-claimed data.app the dialog must ignore
}) {
  // The shell's server-resolved current app.
  ;(window as unknown as { __mochi_shell?: { appId?: string } }).__mochi_shell = {
    appId: opts.app,
  }
  // Requests must arrive from the loaded app iframe; spy on its postMessage so
  // tests can assert the permission-result sent back to it.
  const source = appFrame.contentWindow as WindowProxy
  const postMessage = vi
    .spyOn(source, 'postMessage')
    .mockImplementation(() => {})

  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'request-permission',
          id: opts.id,
          app: opts.spoofApp ?? opts.app, // self-asserted — must be ignored
          permission: opts.permission,
          restricted: opts.restricted,
        },
        source,
      })
    )
  })

  return { postMessage }
}

function grantCall() {
  return mockFetch.mock.calls.find(
    ([url]) => typeof url === 'string' && url.endsWith('/permissions/grant')
  )
}

describe('usePermissionRequest', () => {
  it('shows no dialog initially', () => {
    render(<TestComponent />)
    expect(screen.queryByText('Permission request')).not.toBeInTheDocument()
  })

  it('shows dialog with the resolved permission name on request-permission message', async () => {
    render(<TestComponent />)

    sendPermissionRequest({
      id: 1,
      app: 'feeds',
      permission: 'accounts/read',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByText('Permission request')).toBeInTheDocument()
    })
    expect(screen.getByText(/Feeds/)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Read connected accounts')).toBeInTheDocument()
    })
  })

  it('shows Allow and Deny buttons for standard permissions', async () => {
    render(<TestComponent />)

    sendPermissionRequest({
      id: 1,
      app: 'feeds',
      permission: 'accounts/read',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    })
  })

  it('shows Close button (no Allow) for restricted permissions', async () => {
    render(<TestComponent />)

    sendPermissionRequest({
      id: 1,
      app: 'feeds',
      permission: 'users/read',
      restricted: true,
    })

    await waitFor(() => {
      // The dialog footer has our Close button; the dialog also has an X close button
      const closeButtons = screen.getAllByRole('button', { name: 'Close' })
      expect(closeButtons.length).toBeGreaterThanOrEqual(1)
      expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
    })
    expect(screen.getByText(/must be enabled/)).toBeInTheDocument()
  })

  it('sends denied on Deny click and closes dialog', async () => {
    const user = userEvent.setup()
    render(<TestComponent />)

    const mockSource = sendPermissionRequest({
      id: 42,
      app: 'feeds',
      permission: 'accounts/read',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Deny' }))

    expect(mockSource.postMessage).toHaveBeenCalledWith(
      { type: 'permission-result', id: 42, result: 'denied' },
      '*'
    )

    await waitFor(() => {
      expect(screen.queryByText('Permission request')).not.toBeInTheDocument()
    })
  })

  it('sends denied on Close click for restricted permissions', async () => {
    const user = userEvent.setup()
    render(<TestComponent />)

    const mockSource = sendPermissionRequest({
      id: 7,
      app: 'feeds',
      permission: 'users/read',
      restricted: true,
    })

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThanOrEqual(1)
    })

    // Click the footer Close button (the one with data-slot="button", not the X close)
    const closeButtons = screen.getAllByRole('button', { name: 'Close' })
    const footerClose = closeButtons.find(btn => btn.getAttribute('data-slot') === 'button')!
    await user.click(footerClose)

    expect(mockSource.postMessage).toHaveBeenCalledWith(
      { type: 'permission-result', id: 7, result: 'denied' },
      '*'
    )
  })

  it('calls grant API and sends granted on Allow click', async () => {
    const user = userEvent.setup()
    render(<TestComponent />)

    const mockSource = sendPermissionRequest({
      id: 10,
      app: 'feeds',
      permission: 'accounts/read',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Allow' }))

    // Verify the grant API was called
    await waitFor(() => {
      expect(grantCall()).toBeTruthy()
    })

    const [url, opts] = grantCall()!
    expect(url).toBe('/menu/-/permissions/grant')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer test-token')

    // Verify the body contains the right parameters
    const body = new URLSearchParams(opts.body)
    expect(body.get('app')).toBe('feeds')
    expect(body.get('permission')).toBe('accounts/read')

    // Verify it responded with granted
    expect(mockSource.postMessage).toHaveBeenCalledWith(
      { type: 'permission-result', id: 10, result: 'granted' },
      '*'
    )
  })

  it('sends denied when grant API fails', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation(
      defaultRouter(() => ({
        ok: false,
        json: async () => ({ error: 'Restricted permissions must be enabled in app settings' }),
      }))
    )

    render(<TestComponent />)

    const mockSource = sendPermissionRequest({
      id: 11,
      app: 'feeds',
      permission: 'accounts/read',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Allow' }))

    await waitFor(() => {
      expect(mockSource.postMessage).toHaveBeenCalledWith(
        { type: 'permission-result', id: 11, result: 'denied' },
        '*'
      )
    })
  })

  it('displays the resolved name for url: permissions', async () => {
    render(<TestComponent />)

    sendPermissionRequest({
      id: 1,
      app: 'wikis',
      permission: 'url:api.github.com',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByText('Access api.github.com')).toBeInTheDocument()
    })
  })

  it('shows the server-resolved display name, never the raw app id', async () => {
    render(<TestComponent />)

    // A production install: the shell's app id is an entity id.
    sendPermissionRequest({
      id: 1,
      app: '12254aHfG39Lqrizh',
      permission: 'groups/write',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByText(/Repositories/)).toBeInTheDocument()
    })
    expect(screen.queryByText(/12254aHfG39Lqrizh/)).not.toBeInTheDocument()
  })

  it('falls back to the raw app id when the name lookup fails', async () => {
    render(<TestComponent />)

    sendPermissionRequest({
      id: 1,
      app: 'unresolvable',
      permission: 'groups/write',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByText(/unresolvable/)).toBeInTheDocument()
    })
  })

  it('uses the server-resolved level, ignoring the message restricted flag', async () => {
    render(<TestComponent />)

    // The app claims its restricted permission is standard — once the server
    // answers, the dialog must still render the restricted variant.
    sendPermissionRequest({
      id: 2,
      app: 'feeds',
      permission: 'users/read',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThanOrEqual(1)
    })
    expect(screen.getByText(/must be enabled/)).toBeInTheDocument()
  })

  it('ignores a spoofed data.app and uses the shell-verified app', async () => {
    const user = userEvent.setup()
    render(<TestComponent />)

    // The loaded app is "feeds" but the message claims to be "wikis".
    sendPermissionRequest({
      id: 20,
      app: 'feeds',
      spoofApp: 'wikis',
      permission: 'accounts/read',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    })
    // Dialog names the real loaded app, not the spoofed one.
    expect(screen.getByText(/Feeds/)).toBeInTheDocument()
    expect(screen.queryByText(/Wikis/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => {
      expect(grantCall()).toBeTruthy()
    })
    // Grant targets the shell-verified app, never the spoofed data.app.
    expect(new URLSearchParams(grantCall()![1].body).get('app')).toBe('feeds')
  })

  it('ignores request-permission from a frame that is not the app iframe', () => {
    render(<TestComponent />)
    ;(window as unknown as { __mochi_shell?: { appId?: string } }).__mochi_shell = {
      appId: 'feeds',
    }
    const rogue = { postMessage: vi.fn() }

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'request-permission',
            id: 99,
            app: 'feeds',
            permission: 'accounts/read',
            restricted: false,
          },
          source: rogue as unknown as WindowProxy,
        })
      )
    })

    // The source is not #app-frame, so no dialog appears.
    expect(screen.queryByText('Permission request')).not.toBeInTheDocument()
  })

  it('does not show a dialog when the shell app id is unavailable', () => {
    render(<TestComponent />)
    // No __mochi_shell.appId set — the dialog cannot identify the app.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'request-permission',
            id: 100,
            app: 'feeds',
            permission: 'accounts/read',
            restricted: false,
          },
          source: appFrame.contentWindow as WindowProxy,
        })
      )
    })
    expect(screen.queryByText('Permission request')).not.toBeInTheDocument()
  })
})

// Shell-driven consent: shell.js (same top window) asks for the user's grant
// before running a capability it hosts on an app's behalf — the microphone
// bridge. It fires a same-window CustomEvent and gets the result back the same
// way, and the granted app is always the shell's server-resolved current app.
describe('usePermissionRequest — shell-driven consent', () => {
  function collectShellResults() {
    const results: Array<{ id: string; result: string }> = []
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      results.push({ id: detail.id, result: detail.result })
    }
    window.addEventListener('mochi-shell-permission-result', handler)
    return {
      results,
      cleanup: () => window.removeEventListener('mochi-shell-permission-result', handler),
    }
  }

  function dispatchShellRequest(id: string, permission: string) {
    act(() => {
      window.dispatchEvent(
        new CustomEvent('mochi-shell-permission-request', {
          detail: { id, permission },
        })
      )
    })
  }

  function setShellApp(appId: string) {
    ;(window as unknown as { __mochi_shell?: { appId?: string } }).__mochi_shell = { appId }
  }

  it('shows the dialog for the shell-resolved app on a shell request', async () => {
    setShellApp('chat')
    render(<TestComponent />)

    dispatchShellRequest('mic-1', 'microphone')

    await waitFor(() => {
      expect(screen.getByText('Permission request')).toBeInTheDocument()
    })
    expect(screen.getByText(/Chat/)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Use the microphone')).toBeInTheDocument()
    })
  })

  it('grants the shell-resolved app and answers via CustomEvent on Allow', async () => {
    const user = userEvent.setup()
    setShellApp('chat')
    const sink = collectShellResults()
    render(<TestComponent />)

    dispatchShellRequest('mic-2', 'microphone')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: 'Allow' }))

    await waitFor(() => {
      expect(grantCall()).toBeTruthy()
    })
    const body = new URLSearchParams(grantCall()![1].body)
    expect(body.get('app')).toBe('chat')
    expect(body.get('permission')).toBe('microphone')

    await waitFor(() => {
      expect(sink.results).toContainEqual({ id: 'mic-2', result: 'granted' })
    })
    sink.cleanup()
  })

  it('answers denied via CustomEvent on Deny and never grants', async () => {
    const user = userEvent.setup()
    setShellApp('chat')
    const sink = collectShellResults()
    render(<TestComponent />)

    dispatchShellRequest('mic-3', 'microphone')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: 'Deny' }))

    await waitFor(() => {
      expect(sink.results).toContainEqual({ id: 'mic-3', result: 'denied' })
    })
    expect(grantCall()).toBeFalsy()
    sink.cleanup()
  })

  it('answers denied immediately when no shell app id is set', async () => {
    const sink = collectShellResults()
    render(<TestComponent />)

    dispatchShellRequest('mic-4', 'microphone')

    await waitFor(() => {
      expect(sink.results).toContainEqual({ id: 'mic-4', result: 'denied' })
    })
    expect(screen.queryByText('Permission request')).not.toBeInTheDocument()
    sink.cleanup()
  })
})

// A non-string permission code would throw while rendering in the trusted tree
// and unmount the whole menu root; a postMessage must not reach that.
describe('usePermissionRequest rejects a malformed request', () => {
  // Bypasses sendPermissionRequest's typed signature: the point is the shapes
  // a hostile app can actually put on the wire.
  function sendRaw(data: Record<string, unknown>) {
    ;(window as unknown as { __mochi_shell?: { appId?: string } }).__mochi_shell = {
      appId: 'feeds',
    }
    const source = appFrame.contentWindow as WindowProxy
    vi.spyOn(source, 'postMessage').mockImplementation(() => {})
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'request-permission', app: 'feeds', ...data },
          source,
        })
      )
    })
  }

  const MALFORMED: [string, Record<string, unknown>][] = [
    ['an object permission', { id: 1, permission: {} }],
    ['an array permission', { id: 1, permission: ['accounts/read'] }],
    ['a null permission', { id: 1, permission: null }],
    ['a numeric permission', { id: 1, permission: 42 }],
    ['a missing permission', { id: 1 }],
    ['an empty permission', { id: 1, permission: '   ' }],
    ['an over-long permission', { id: 1, permission: 'x'.repeat(257) }],
    ['a string id', { id: 'one', permission: 'accounts/read' }],
    ['a missing id', { permission: 'accounts/read' }],
  ]

  it.each(MALFORMED)('ignores %s and keeps the chrome mounted', async (_name, data) => {
    render(
      <div>
        <span data-testid='chrome'>chrome</span>
        <TestComponent />
      </div>
    )

    sendRaw(data)
    await waitFor(() => {
      expect(screen.queryByText('Permission request')).not.toBeInTheDocument()
    })

    // The real damage was never the missing dialog — it was everything ELSE
    // disappearing with it. Unfixed, the object cases threw during render and
    // this node went with the root.
    expect(screen.getByTestId('chrome')).toBeInTheDocument()
  })

  it('still accepts a well-formed request', async () => {
    // Companion to the refusals: the guard rejects malformed shapes, not every
    // request, so the empty-dialog assertions above mean something.
    render(<TestComponent />)
    sendRaw({ id: 1, permission: 'accounts/read' })
    await waitFor(() => {
      expect(screen.getByText('Permission request')).toBeInTheDocument()
    })
  })

  it('trims a padded permission rather than looking it up with the padding', async () => {
    render(<TestComponent />)
    sendRaw({ id: 1, permission: '  accounts/read  ' })
    await waitFor(() => {
      expect(screen.getByText('Read connected accounts')).toBeInTheDocument()
    })
  })
})

// The boundary around the dialog never clears its own failed state — that is
// what keeps a render error from unmounting the whole menu root. So it has to
// be a FRESH boundary per request, or the first failure silently swallows every
// later consent request and the user's only way back is a reload.
describe('usePermissionRequest survives a dialog that fails to render', () => {
  // A non-string name from the server reaches {permissionName} and throws
  // during render — a real path to the failure rather than a stubbed component.
  let breakName: boolean
  beforeEach(() => {
    breakName = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockFetch.mockImplementation((url: string, opts?: { body?: string }) => {
      if (typeof url === 'string' && url.endsWith('/permissions/name')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: { name: breakName ? {} : 'Read connected accounts', restricted: false },
          }),
        })
      }
      if (typeof url === 'string' && url.endsWith('/permissions/application')) {
        return Promise.resolve(applicationResponse(opts))
      }
      return Promise.resolve({ ok: true, json: async () => ({ data: { status: 'granted' } }) })
    })
  })

  it('renders a later request after an earlier one threw', async () => {
    render(
      <div>
        <span data-testid='chrome'>chrome</span>
        <TestComponent />
      </div>
    )

    sendPermissionRequest({ id: 1, app: 'feeds', permission: 'accounts/read', restricted: false })

    // The dialog fails and disappears, but the chrome around it lives.
    await waitFor(() => {
      expect(screen.queryByText('Permission request')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('chrome')).toBeInTheDocument()

    // A well-formed request afterwards must still be answerable. With a single
    // boundary shared across requests, this rendered nothing at all.
    breakName = false
    sendPermissionRequest({ id: 2, app: 'feeds', permission: 'accounts/read', restricted: false })

    await waitFor(() => {
      expect(screen.getByText('Permission request')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    })
  })

  it('replaces the previous request\'s permission name', async () => {
    // A guard, not a reproduction: the effect keyed on `pending` already clears
    // the name, and act() flushes it before this can observe an intermediate
    // render. It is here so that dropping that reset — leaving one request's
    // permission named in the dialog that grants the next — fails loudly.
    breakName = false
    render(<TestComponent />)

    sendPermissionRequest({ id: 1, app: 'feeds', permission: 'accounts/read', restricted: false })
    await waitFor(() => {
      expect(screen.getByText('Read connected accounts')).toBeInTheDocument()
    })

    sendPermissionRequest({ id: 2, app: 'feeds', permission: 'groups/write', restricted: false })
    expect(screen.queryByText('Read connected accounts')).not.toBeInTheDocument()
  })
})
