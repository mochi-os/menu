# Mochi Menu backend — proxies notification/push operations via service calls
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

# Notification display (replaces direct HTTP calls to notifications app)

def action_notifications_list(a):
    """List notifications for the current user."""
    result = mochi.service.call("notifications", "list")
    if result == None:
        return {"data": []}
    return {"data": result}

def action_notifications_read(a):
    """Mark a single notification as read. Ids reach ~310 bytes (app id +
    ":" + event id, and legacy raw structured event ids), so the cap
    matches the notifications app's own read action."""
    id = a.input("id", "").strip()
    if not id:
        return a.error.label(400, "errors.id_is_required")
    if len(id) > 512:
        return a.error.label(400, "errors.invalid_id")
    mochi.service.call("notifications", "read", id)
    return {"data": {"ok": True}}

def action_notifications_read_all(a):
    """Mark all notifications as read."""
    mochi.service.call("notifications", "read/all")
    return {"data": {"ok": True}}

# Per-notification category picker support

def action_notifications_categories(a):
    """Return the user's notification categories (id + label, no destinations)."""
    result = mochi.service.call("notifications", "categories")
    return {"data": result or []}

# The notifications service caps these at the same lengths (function_send);
# refuse at the boundary rather than passing on a value it will reject.
APP_MAXIMUM = 64
TOPIC_MAXIMUM = 128
OBJECT_MAXIMUM = 256

def topic_bounded(app, topic, object):
    return len(app) <= APP_MAXIMUM and len(topic) <= TOPIC_MAXIMUM and len(object) <= OBJECT_MAXIMUM

def action_notifications_topic_lookup(a):
    """Find the topic row matching (app, topic, object) so the picker can show
    the current category. app="" matches server-originated topics."""
    app = a.input("app", "").strip()
    topic = a.input("topic", "").strip()
    object = a.input("object", "").strip()
    if not topic_bounded(app, topic, object):
        return a.error.label(400, "errors.invalid_id")
    row = mochi.service.call("notifications", "topic/lookup", app, topic, object)
    return {"data": row}

def action_notifications_topic_category_set(a):
    """Set the category of a topic row by (app, topic, object). app="" matches
    server-originated topics (upgrade alerts etc.). An empty category clears the
    topic's category; anything over-long cannot name a real category and is
    rejected rather than treated as a clear."""
    app = a.input("app", "").strip()
    topic = a.input("topic", "").strip()
    object = a.input("object", "").strip()
    category = a.input("category", "").strip()
    if not topic_bounded(app, topic, object):
        return a.error.label(400, "errors.invalid_id")
    if category == "":
        category = None
    elif len(category) > 64:
        return a.error.label(404, "errors.not_found")
    ok = mochi.service.call("notifications", "topic/category/set", app, topic, object, category)
    if not ok:
        return a.error.label(404, "errors.not_found")
    return {"data": {}}

# Push registration — proxies to the notifications app's accounts/* services
# so the shell user-menu (top window) can manage browser push subscriptions.

def action_push_vapid(a):
    """Get VAPID key for browser push subscription."""
    result = mochi.service.call("notifications", "accounts/vapid")
    if result == None:
        return a.error.label(503, "errors.push_notifications_not_available")
    return {"data": result}

def action_push_accounts_list(a):
    """List browser push accounts."""
    capability = a.input("capability", "")
    result = mochi.service.call("notifications", "accounts/list", capability)
    return {"data": result or []}

def action_push_accounts_add(a):
    """Register a browser push account."""
    type = a.input("type", "").strip()
    if not type:
        return a.error.label(400, "errors.type_is_required")

    fields = {}
    for key in ["label", "endpoint", "auth", "p256dh"]:
        val = a.input(key, "")
        if val != "":
            fields[key] = val

    result = mochi.service.call("notifications", "accounts/add", type, **fields)
    return {"data": result or {}}

def action_push_accounts_remove(a):
    """Remove a browser push account."""
    id = a.input("id", "").strip()
    # Account ids are mochi.uid() text since the integer-id re-keying; only
    # pre-migration rows kept digit ids, so an isdigit() check rejects every
    # account created since.
    if not id or len(id) > 64:
        return a.error.label(400, "errors.invalid_id")

    result = mochi.service.call("notifications", "accounts/remove", id)
    return {"data": result or {}}

# Permission grant (shell-managed permission request dialog)

def action_permissions_grant(a):
    """Grant a standard permission to an app on behalf of the user."""
    app_id = a.input("app", "").strip()
    permission = a.input("permission", "").strip()
    if not app_id or not permission:
        return a.error.label(400, "errors.app_and_permission_are_required")

    # Only real apps may receive grants — a grant row for an arbitrary id would
    # become live if an app with that id were installed later
    if not mochi.app.get(app_id):
        return a.error.label(404, "errors.not_found")

    # Block non-standard permissions — they must be configured in app settings
    if mochi.permission.level(permission) != "standard":
        return a.error.label(403, "errors.restricted_permissions_disabled")

    mochi.permission.grant(app_id, permission)
    return {"data": {"status": "granted"}}

def action_permissions_name(a):
    """Resolve a permission code to its translated, human-readable name and its
    level. The consent dialog uses the server-resolved restricted flag, never
    the requesting app's self-asserted one."""
    permission = a.input("permission", "").strip()
    if not permission:
        return a.error.label(400, "errors.permission_is_required")

    return {"data": {
        "name": mochi.permission.name(permission),
        "restricted": mochi.permission.level(permission) != "standard",
    }}

def action_permissions_application(a):
    """Resolve an app id to its display name in the user's language. The consent
    dialog shows this instead of the raw id — on production installs the id is
    an entity id, meaningless to the user."""
    app = mochi.app.get(a.input("app", "").strip())
    if not app:
        return a.error.label(404, "errors.not_found")

    return {"data": {"name": app["name"]}}

def action_permissions_check(a):
    """Report whether an app currently holds a permission for this user. Used by
    the shell to gate capabilities it grants on an app's behalf (e.g. the
    microphone bridge) against the server-resolved current app id."""
    app_id = a.input("app", "").strip()
    permission = a.input("permission", "").strip()
    if not app_id or not permission:
        return a.error.label(400, "errors.app_and_permission_are_required")
    if len(app_id) > APP_MAXIMUM:
        return a.error.label(400, "errors.invalid_id")

    # No mochi.app.get here, unlike action_permissions_grant: an app that does
    # not exist holds no grants, so the answer is already granted: false.
    granted = False
    for p in mochi.permission.list(app_id):
        if p["permission"] == permission and p["granted"]:
            granted = True
            break
    return {"data": {"granted": granted}}
