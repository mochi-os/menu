// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { shellPage } from './shell-page'

const PAGE = readFileSync(resolve(__dirname, '../public/shell.html'), 'utf8')
const SRC = '/menu/assets/shell-AbCd1234.js'

describe('shellPage', () => {
  it('loads shell.js from its hashed file where the page inlined it', () => {
    const page = shellPage(PAGE, SRC)
    expect(page).not.toBeNull()
    expect(page).not.toContain('{{SHELL_JS}}')
    expect(page).toContain(`<script nonce="{{NONCE}}" src="${SRC}"></script>`)
    // Same place: after the page's own markup, before the menu's bundle.
    expect(page!.indexOf(SRC)).toBeGreaterThan(
      page!.indexOf('id="app-container"')
    )
    expect(page!.indexOf(SRC)).toBeLessThan(page!.indexOf('{{MENU_JS}}'))
    // Everything core still fills in stays.
    for (const placeholder of [
      '{{HTML_CLASS}}',
      '{{THEME_STYLE}}',
      '{{APPEARANCE_SCRIPT}}',
      '{{MENU_CSS}}',
      '{{MENU_JS}}',
    ]) {
      expect(page).toContain(placeholder)
    }
  })

  it('refuses a page with no inline block', () => {
    expect(shellPage('<html><body></body></html>', SRC)).toBeNull()
  })
})
