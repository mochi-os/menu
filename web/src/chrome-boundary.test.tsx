// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChromeBoundary } from './chrome-boundary'

// React logs the caught error; the boundary is the thing under test, so the
// noise is silenced rather than left to imply a failure.
afterEach(() => {
  vi.restoreAllMocks()
})

function Throws(): React.ReactNode {
  throw new Error('component failed')
}

describe('ChromeBoundary', () => {
  it('renders its children when nothing fails', () => {
    render(
      <ChromeBoundary>
        <span data-testid='child'>content</span>
      </ChromeBoundary>
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('renders nothing in place of a failed subtree, and keeps its siblings', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <div>
        <span data-testid='sidebar'>sidebar</span>
        <ChromeBoundary>
          <Throws />
        </ChromeBoundary>
        <span data-testid='signout'>sign out</span>
      </div>
    )

    // The whole point: without a boundary React unmounts the ROOT on an
    // escaped render error, so the user loses the chrome — and their way to
    // sign out — until they reload.
    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('signout')).toBeInTheDocument()
    expect(screen.queryByText('component failed')).not.toBeInTheDocument()
  })

  it('leaves no remnant of the failed subtree behind', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <ChromeBoundary>
        <div data-testid='dialog'>
          <button>Allow</button>
          <Throws />
        </div>
      </ChromeBoundary>
    )

    // A consent dialog that half-renders would be worse than none: a clickable
    // Allow with nothing explaining what it grants.
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
