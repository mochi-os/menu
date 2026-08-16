// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useState } from 'react'
import {
  toast,
  getErrorMessage,
  type NotificationCategory,
  type NotificationTopic,
} from '@mochi/web'
import { useLingui } from '@lingui/react/macro'
import { menuFetch } from './menu-api'

/**
 * Drives the shared category picker from the menu app's own actions.
 *
 * The picker itself holds no data and issues no request: it ships in every
 * app's bundle and cannot read the notifications service on an app's behalf.
 * The menu app holds notifications/write, so here the fetch is same-app and
 * legitimate - which is why this hook lives beside the routes it calls rather
 * than inside the shared component.
 *
 * Only one picker is open at a time, so a single slot of state serves every row.
 */
export function useMenuCategories() {
  const { t } = useLingui()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [categories, setCategories] = useState<NotificationCategory[] | null>(null)
  const [topic, setTopic] = useState<NotificationTopic | null>(null)
  const [saving, setSaving] = useState(false)

  const keyFor = (app: string, topicName: string, object: string) =>
    `${app} ${topicName} ${object}`

  const open = async (app: string, topicName: string, object: string) => {
    setOpenKey(keyFor(app, topicName, object))
    setCategories(null)
    setTopic(null)
    try {
      const params = new URLSearchParams({ app, topic: topicName, object })
      const [categoriesResponse, topicResponse] = await Promise.all([
        menuFetch<{ data: NotificationCategory[] }>('-/notifications/categories'),
        menuFetch<{ data: NotificationTopic | null }>(
          `-/notifications/topic/lookup?${params.toString()}`
        ),
      ])
      setCategories(categoriesResponse.data || [])
      setTopic(topicResponse.data || null)
    } catch (error) {
      setCategories([])
      toast.error(getErrorMessage(error, t`Failed to load notification categories`))
    }
  }

  const close = () => {
    setOpenKey(null)
    setCategories(null)
    setTopic(null)
  }

  const changeCategory = async (row: NotificationTopic, category: string) => {
    setSaving(true)
    try {
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
      setTopic({ ...row, category: parseInt(category, 10) })
      const topicLabel = row.label || row.topic
      const chosen = categories?.find((c) => String(c.id) === category)
      const categoryLabel = chosen ? (chosen.display ?? chosen.label) : null
      toast.success(
        categoryLabel
          ? t`${topicLabel} moved to the ${categoryLabel} category`
          : t`Category updated`
      )
      close()
    } catch (error) {
      toast.error(getErrorMessage(error, t`Failed to update category`))
    } finally {
      setSaving(false)
    }
  }

  return { keyFor, openKey, categories, topic, saving, open, close, changeCategory }
}
