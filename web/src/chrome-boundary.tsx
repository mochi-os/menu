// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { Component, type ErrorInfo, type ReactNode } from 'react'

// Isolates one part of the trusted chrome from the rest. React unmounts the
// entire root when a render error escapes, so without a boundary a throw while
// rendering app-supplied content — a permission code, a notification title —
// takes the sidebar, the notification badge and sign-out down with it, and the
// user's only way back is a reload. The subtree renders nothing instead.
//
// Nothing is shown in its place. The chrome has no room for an error panel, and
// a consent dialog that fails to render must leave no clickable remnant behind:
// the requesting app simply never receives an answer, which is where every
// other unanswered request already leaves it.
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
