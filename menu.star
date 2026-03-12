# Mochi Menu backend — proxies notification/push operations via service calls
# Copyright Alistair Cunningham 2026

# Notification display (replaces direct HTTP calls to notifications app)

def action_notifications_list(a):
    """List notifications for the current user."""
    result = mochi.service.call("notifications", "list")
    if result == None:
        return {"data": [], "count": 0, "total": 0}
    return result

def action_notifications_read(a):
    """Mark a single notification as read."""
    id = a.input("id", "").strip()
    if not id:
        return a.error(400, "id is required")
    mochi.service.call("notifications", "read", id)
    return {"data": {"ok": True}}

def action_notifications_read_all(a):
    """Mark all notifications as read."""
    mochi.service.call("notifications", "read/all")
    return {"data": {"ok": True}}

# Subscribe dialog support

def action_notifications_destinations(a):
    """Return notification destinations via service call."""
    result = mochi.service.call("notifications", "destinations")
    if result == None:
        return {"data": {"accounts": [], "feeds": []}}
    return {"data": result}

def action_notifications_subscribe(a):
    """Create subscriptions via service call with explicit app."""
    app = a.input("app", "").strip()
    label = a.input("label", "").strip()
    type = a.input("type", "").strip()
    object = a.input("object", "").strip()
    destinations = a.input("destinations", "")

    if not app:
        return a.error(400, "app is required")
    if not label:
        return a.error(400, "label is required")

    destinations_list = json.decode(destinations) if destinations else []

    result = mochi.service.call("notifications", "subscribe", app, label, type, object, destinations_list)
    return {"data": {"id": result}}

def action_notifications_subscriptions(a):
    """List notification subscriptions for the current user."""
    result = mochi.service.call("notifications", "subscriptions")
    if result == None:
        return {"data": []}
    return {"data": result}

def action_notifications_unsubscribe(a):
    """Delete a notification subscription."""
    id = a.input("id", "").strip()
    if not id:
        return a.error(400, "id is required")
    mochi.service.call("notifications", "unsubscribe", id)
    return {"data": {"ok": True}}

# Push registration (replaces direct HTTP calls to notifications accounts)

def action_push_vapid(a):
    """Get VAPID key for browser push subscription."""
    result = mochi.service.call("notifications", "accounts/vapid")
    if result == None:
        return a.error(503, "Push notifications not available")
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
        return a.error(400, "type is required")

    fields = {}
    for key in ["label", "endpoint", "auth", "p256dh"]:
        val = a.input(key)
        if val:
            fields[key] = val

    result = mochi.service.call("notifications", "accounts/add", type, **fields)
    return {"data": result or {}}

def action_push_accounts_remove(a):
    """Remove a browser push account."""
    id = a.input("id", "").strip()
    if not id or not id.isdigit():
        return a.error(400, "Invalid id")

    result = mochi.service.call("notifications", "accounts/remove", int(id))
    return {"data": result or {}}

# Permission grant (shell-managed permission request dialog)

def action_permissions_grant(a):
    """Grant a standard permission to an app on behalf of the user."""
    app_id = a.input("app", "").strip()
    permission = a.input("permission", "").strip()
    if not app_id or not permission:
        return a.error(400, "app and permission are required")

    # Block restricted permissions — they must be configured in app settings
    if mochi.permission.restricted(permission):
        return a.error(403, "Restricted permissions must be enabled in app settings")

    mochi.permission.grant(app_id, permission)
    return {"data": {"status": "granted"}}
