"""Slack API helpers: user/channel resolution and mention detection."""

import logging

from config import WATCHED_USER_NAME, WATCHED_GROUPS

logger = logging.getLogger(__name__)

_watched_user_id: str | None = None
_dm_channel_id: str | None = None


def is_mentioned(text: str, user_id: str) -> bool:
    """Return True if text contains a direct @mention of user_id or any watched group."""
    if f"<@{user_id}>" in text:
        return True
    for group in WATCHED_GROUPS:
        if group in ("channel", "here"):
            if f"<!{group}>" in text:
                return True
        else:
            # User groups: <!subteam^SXXXXXXXX|group-handle>
            if f"|{group}>" in text:
                return True
    return False


def resolve_user_id(client) -> str | None:
    """Resolve WATCHED_USER_NAME to a Slack user ID (cached)."""
    global _watched_user_id
    if _watched_user_id:
        return _watched_user_id
    cursor = None
    while True:
        kwargs: dict = {"limit": 200}
        if cursor:
            kwargs["cursor"] = cursor
        result = client.users_list(**kwargs)
        for user in result["members"]:
            if WATCHED_USER_NAME in (
                user.get("name", ""),
                user.get("profile", {}).get("display_name", ""),
            ):
                _watched_user_id = user["id"]
                logger.info("Resolved '%s' -> %s", WATCHED_USER_NAME, _watched_user_id)
                return _watched_user_id
        cursor = result.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            break
    logger.warning("Could not find Slack user '%s'", WATCHED_USER_NAME)
    return None


def resolve_dm_channel(client) -> str | None:
    """Open (or reuse) the DM channel with the watched user (cached)."""
    global _dm_channel_id
    if _dm_channel_id:
        return _dm_channel_id
    user_id = resolve_user_id(client)
    if not user_id:
        return None
    try:
        result = client.conversations_open(users=[user_id])
        _dm_channel_id = result["channel"]["id"]
        logger.info("DM channel: %s", _dm_channel_id)
        return _dm_channel_id
    except Exception as exc:
        logger.error("Could not open DM with %s: %s", WATCHED_USER_NAME, exc)
        return None


def get_channel_id(body: dict) -> str:
    """Extract a channel ID from an action body.

    body['channel'] is a dict in channels but a plain string ID in DMs.
    """
    ch = body.get("channel", {})
    return ch.get("id") if isinstance(ch, dict) else ch
