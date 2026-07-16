// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import { mochiPlugin } from '@mochi/web/vite'
import { lingui } from '@lingui/vite-plugin'

export default defineConfig({
  base: './',
  plugins: [
    mochiPlugin(),
    react({
      plugins: [['@lingui/swc-plugin', {}]],
    }),
    lingui(),
    tailwindcss(),
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
