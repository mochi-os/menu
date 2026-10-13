// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import {
  useNotificationCategoryPicker,
  type NotificationCategory,
  type NotificationTopic,
} from '@mochi/web'
import { menuFetch } from './menu-api'

async function listCategories(): Promise<NotificationCategory[]> {
  const response = await menuFetch<{ data: NotificationCategory[] }>(
    '-/notifications/categories'
  )
  return response.data || []
}

async function lookupTopic(
  app: string,
  topic: string,
  object: string
): Promise<NotificationTopic | null> {
  const params = new URLSearchParams({ app, topic, object })
  const response = await menuFetch<{ data: NotificationTopic | null }>(
    `-/notifications/topic/lookup?${params.toString()}`
  )
  return response.data || null
}

async function setTopicCategory(
  row: NotificationTopic,
  category: string
): Promise<void> {
  const params = new URLSearchParams({
    app: row.app,
    topic: row.topic,
    object: row.object,
    category,
  })
  await menuFetch('-/notifications/topic/category/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
}

/**
 * Drives the shared category picker from the menu app's own actions: the picker
 * ships in every app's bundle and cannot fetch on an app's behalf, while the
 * menu holds notifications/write.
 */
export function useMenuCategories() {
  return useNotificationCategoryPicker({
    listCategories,
    lookupTopic,
    setTopicCategory,
  })
}
