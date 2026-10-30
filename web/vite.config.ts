// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import path from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { lingui } from '@lingui/vite-plugin'
import { mochiPlugin } from '@mochi/web/vite'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import { shellPage } from './src/shell-page'

// Emit public/shell.js as a hashed asset the browser keeps, and have the built
// shell.html load it where it was inlined. public/ still puts shell.js in dist
// for a core that inlines it.
function shellScript(): Plugin {
  return {
    name: 'mochi-shell-script',
    apply: 'build',
    generateBundle() {
      const reference = this.emitFile({
        type: 'asset',
        name: 'shell.js',
        source: fs.readFileSync(path.resolve(__dirname, 'public/shell.js')),
      })
      const page = shellPage(
        fs.readFileSync(path.resolve(__dirname, 'public/shell.html'), 'utf8'),
        `/menu/${this.getFileName(reference)}`
      )
      if (page === null) {
        // eslint-disable-next-line lingui/no-unlocalized-strings -- a build error for developers, never shown to users
        this.error('public/shell.html has no inline shell.js block to replace')
      }
      this.emitFile({ type: 'asset', fileName: 'shell.html', source: page })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [
    mochiPlugin(),
    react({
      plugins: [['@lingui/swc-plugin', {}]],
    }),
    lingui(),
    tailwindcss(),
    shellScript(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
})
