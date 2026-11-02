// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The inline script block public/shell.html carries for a core that pastes
// shell.js into the page.
const inline = /<script nonce="\{\{NONCE\}\}">\s*\{\{SHELL_JS\}\}\s*<\/script>/

// shellPage has the shell page load shell.js from src, a hashed file the
// browser keeps, in place of the inline copy: the page itself is never cached,
// so an inlined script is downloaded again on every top-level load. Null when
// the page has no inline block to replace.
export function shellPage(page: string, src: string): string | null {
  if (!inline.test(page)) return null
  return page.replace(
    inline,
    () => `<script nonce="{{NONCE}}" src="${src}"></script>`
  )
}
