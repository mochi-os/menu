import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { usePermissionRequest } from './use-permission-request'

// Mock fetch globally
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

// Mock the shell token
beforeEach(() => {
  ;(window as unknown as { __mochi_shell?: { menuToken?: string } }).__mochi_shell = {
    menuToken: 'test-token',
  }
  mockFetch.mockReset()
})

afterEach(() => {
  delete (window as unknown as { __mochi_shell?: unknown }).__mochi_shell
})

// Test wrapper that renders the hook's dialog
function TestComponent() {
  const { dialog } = usePermissionRequest()
  return <div>{dialog}</div>
}

function sendPermissionRequest(opts: {
  id: number
  app: string
  permission: string
  restricted: boolean
}) {
  // Create a mock source with postMessage
  const mockSource = { postMessage: vi.fn() }

  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'request-permission',
          ...opts,
        },
        source: mockSource as unknown as WindowProxy,
      })
    )
  })

  return mockSource
}

describe('usePermissionRequest', () => {
  it('shows no dialog initially', () => {
    render(<TestComponent />)
    expect(screen.queryByText('Permission request')).not.toBeInTheDocument()
  })

  it('shows dialog on request-permission message', async () => {
    render(<TestComponent />)

    sendPermissionRequest({
      id: 1,
      app: 'feeds',
      permission: 'account/read',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByText('Permission request')).toBeInTheDocument()
    })
    expect(screen.getByText(/Feeds/)).toBeInTheDocument()
    expect(screen.getByText(/read connected accounts/)).toBeInTheDocument()
  })

  it('shows Allow and Deny buttons for standard permissions', async () => {
    render(<TestComponent />)

    sendPermissionRequest({
      id: 1,
      app: 'feeds',
      permission: 'account/read',
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
      permission: 'user/read',
      restricted: true,
    })

    await waitFor(() => {
      // The dialog footer has our Close button; the dialog also has an X close button
      const closeButtons = screen.getAllByRole('button', { name: 'Close' })
      expect(closeButtons.length).toBeGreaterThanOrEqual(1)
      expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
    })
    expect(screen.getByText(/restricted permission/)).toBeInTheDocument()
  })

  it('sends denied on Deny click and closes dialog', async () => {
    const user = userEvent.setup()
    render(<TestComponent />)

    const mockSource = sendPermissionRequest({
      id: 42,
      app: 'feeds',
      permission: 'account/read',
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
      permission: 'user/read',
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
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { status: 'granted' } }),
    })

    render(<TestComponent />)

    const mockSource = sendPermissionRequest({
      id: 10,
      app: 'feeds',
      permission: 'account/read',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Allow' }))

    // Verify the grant API was called
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('/menu/-/permissions/grant')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer test-token')

    // Verify the body contains the right parameters
    const body = new URLSearchParams(opts.body)
    expect(body.get('app')).toBe('feeds')
    expect(body.get('permission')).toBe('account/read')

    // Verify it responded with granted
    expect(mockSource.postMessage).toHaveBeenCalledWith(
      { type: 'permission-result', id: 10, result: 'granted' },
      '*'
    )
  })

  it('sends denied when grant API fails', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Restricted permissions must be enabled in app settings' }),
    })

    render(<TestComponent />)

    const mockSource = sendPermissionRequest({
      id: 11,
      app: 'feeds',
      permission: 'account/read',
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

  it('displays correct label for url: permissions', async () => {
    render(<TestComponent />)

    sendPermissionRequest({
      id: 1,
      app: 'wikis',
      permission: 'url:api.github.com',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByText(/access api.github.com/)).toBeInTheDocument()
    })
  })

  it('capitalizes app name', async () => {
    render(<TestComponent />)

    sendPermissionRequest({
      id: 1,
      app: 'repositories',
      permission: 'group/manage',
      restricted: false,
    })

    await waitFor(() => {
      expect(screen.getByText(/Repositories/)).toBeInTheDocument()
    })
  })
})
