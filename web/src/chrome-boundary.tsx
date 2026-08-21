// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { Component, type ErrorInfo, type ReactNode } from 'react'

// Error boundary for one part of the trusted chrome: a render error in
// app-supplied content (a permission code, a notification title) would
// otherwise unmount the whole menu root. The failed subtree renders nothing - a
// half-rendered consent dialog must leave no clickable remnant.
interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

export class ChromeBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Not DEV-gated: catching the error is what stops React reporting it, and a
    // subtree that disappears with no trace anywhere is a bug report nobody can
    // act on.
    // eslint-disable-next-line no-console
    console.error('[menu] chrome component failed', error, info.componentStack)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
