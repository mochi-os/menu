// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The apps the user can open, from the menu's own apps action.
import { useQuery } from '@tanstack/react-query'
import { menuFetch } from './menu-api'

export interface MenuApp {
  id: string
  path: string
  name: string
  file: string
  link: string
  highlight?: boolean
}

interface AppsResponse {
  icons: MenuApp[]
  icon_mask?: string
  icon_background?: string
}

export function useMenuApps() {
  return useQuery({
    queryKey: ['menu', 'apps'],
    queryFn: () =>
      menuFetch<{ data: AppsResponse }>('-/apps').then(
        (response) => response.data
      ),
    staleTime: 5 * 60 * 1000,
  })
}
