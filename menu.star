# Mochi Menu backend — proxies notification/push operations via service calls
# Copyright Alistair Cunningham 2026

# Notification display (replaces direct HTTP calls to notifications app)

def action_notifications_list(a):
    """List notifications for the current user."""
    result = mochi.service.call("notifications", "list")
    if result == None:
        return {"data": [], "count": 0, "total": 0}
    count = 0
    total = 0
    for n in result:
        if n.get("read", 0) == 0:
            count += 1
            total += n.get("count", 1)
    return {"data": result, "count": count, "total": total}

def action_notifications_read(a):
    """Mark a single notification as read."""
    id = a.input("id", "").strip()
    if not id:
        return a.error.label(400, "errors.id_is_required")
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

def action_notifications_topic_lookup(a):
    """Find the topic row matching (app, topic, object) so the picker can show
    the current category. app="" matches server-originated topics."""
    app = a.input("app", "").strip()
    topic = a.input("topic", "").strip()
    object = a.input("object", "").strip()
    row = mochi.service.call("notifications", "topic/lookup", app, topic, object)
    return {"data": row}

def action_notifications_topic_set_category(a):
    """Set the category of a topic row by (app, topic, object). app="" matches
    server-originated topics (upgrade alerts etc.)."""
    app = a.input("app", "").strip()
    topic = a.input("topic", "").strip()
    object = a.input("object", "")
    cat_raw = a.input("category", "")
    category = None
    if cat_raw != "" and cat_raw.lstrip("-").isdigit():
        category = int(cat_raw)
    ok = mochi.service.call("notifications", "topic/set_category", app, topic, object, category)
    if not ok:
        return a.error.label(404, "errors.not_found")
    return {"data": {}}

# Push registration (replaces direct HTTP calls to notifications accounts)

# Permission grant (shell-managed permission request dialog)

def action_permissions_grant(a):
    """Grant a standard permission to an app on behalf of the user."""
    app_id = a.input("app", "").strip()
    permission = a.input("permission", "").strip()
    if not app_id or not permission:
        return a.error.label(400, "errors.app_and_permission_are_required")

    # Block non-standard permissions — they must be configured in app settings
    if mochi.permission.level(permission) != "standard":
        return a.error.label(403, "errors.restricted_permissions_disabled")

    mochi.permission.grant(app_id, permission)
    return {"data": {"status": "granted"}}

def action_permissions_name(a):
    """Resolve a permission code to its translated, human-readable name."""
    permission = a.input("permission", "").strip()
    if not permission:
        return a.error.label(400, "errors.permission_is_required")

    return {"data": {"name": mochi.permission.name(permission)}}
