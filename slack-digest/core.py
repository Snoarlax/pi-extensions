"""Core logic: fingerprint reconciliation, thread surfacing, and backfill."""

import logging
import time

from config import BACKFILL_DAYS
from state import tracked_threads, message_log, save_state
from slack_helpers import resolve_dm_channel, resolve_user_id, is_mentioned
from blocks import make_blocks

logger = logging.getLogger(__name__)


def _api(fn, *args, **kwargs):
    """Call a Slack SDK method, retrying transparently on rate-limit errors.

    Reads the Retry-After header from the response and sleeps for that many
    seconds before retrying. All other exceptions propagate normally.
    """
    while True:
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            if "ratelimited" not in str(exc):
                raise
            retry_after = 30
            try:
                retry_after = int(exc.response.headers.get("Retry-After", 30))
            except Exception:
                pass
            logger.warning("Rate limited; retrying in %d s", retry_after)
            time.sleep(retry_after)


# Maps first-message fingerprint -> {digest_ts, last_ts}
# Built on startup from DM history; used to avoid duplicate top-level DM posts.
_fingerprints: dict[str, dict] = {}

# Tracks DM message timestamps already added to message_log to prevent
# double-insertion across backfill, real-time events, and restart rebuilds.
_seen_dm_ts: set[str] = set()


def _fingerprint(text: str) -> str:
    return text.strip()


# ---------------------------------------------------------------------------
# DM message helpers
# ---------------------------------------------------------------------------

def _resolve_dm_thread_key(digest_ts: str) -> str:
    """Given the thread_ts of a DM reply, return the source thread_key if
    known, otherwise a stable dm: key derived from the digest thread ts."""
    match = next((k for k, v in tracked_threads.items() if v.get("digest_ts") == digest_ts), None)
    return match if match else f"dm:{digest_ts}"


def add_dm_message_to_log(ts: str, text: str, thread_key: str | None = None) -> None:
    """Idempotently insert a user-sent DM message into message_log.

    thread_key should be:
      - the source thread key (channel:thread_ts) when replying to a digest thread
      - f"dm:{ts}" for a standalone top-level DM
    """
    if ts in _seen_dm_ts:
        return
    _seen_dm_ts.add(ts)
    message_log.insert(0, {
        "thread_key": thread_key if thread_key is not None else f"dm:{ts}",
        "text": text,
        "ts": ts,
        "type": "user_message",
    })


# ---------------------------------------------------------------------------
# Startup: rebuild state from DM history
# ---------------------------------------------------------------------------

def build_digest_fingerprints(client) -> None:
    """Scan DM history on startup and populate the fingerprint map."""
    dm_channel = resolve_dm_channel(client)
    if not dm_channel:
        return
    logger.info("Scanning DM history for existing threads...")
    cursor = None
    while True:
        kwargs: dict = {"channel": dm_channel, "limit": 200}
        if cursor:
            kwargs["cursor"] = cursor
        try:
            result = _api(client.conversations_history, **kwargs)
        except Exception as exc:
            logger.warning("Could not scan DM history: %s", exc)
            return
        for msg in result.get("messages", []):
            ts = msg["ts"]
            if msg.get("thread_ts", ts) != ts:
                continue
            fp = _fingerprint(msg.get("text", ""))
            if fp:
                _fingerprints[fp] = {"digest_ts": ts, "last_ts": msg.get("latest_reply") or ts}
        cursor = result.get("response_metadata", {}).get("next_cursor")
        if not cursor or not result.get("has_more"):
            break
    logger.info("Loaded %d existing threads from DM history", len(_fingerprints))


def populate_message_log_from_dm(client) -> None:
    """Rebuild message_log from DM history on startup.

    Populates bot-posted digest entries (linked to their source thread_key via
    tracked_threads) and user-sent DM messages.
    """
    dm_channel = resolve_dm_channel(client)
    if not dm_channel:
        return
    user_id = resolve_user_id(client)
    if not user_id:
        return

    # Reverse map: digest_ts -> thread_key so bot messages can be re-linked
    digest_ts_to_key = {
        v["digest_ts"]: k
        for k, v in tracked_threads.items()
        if v.get("digest_ts")
    }

    entries: list[dict] = []
    cursor = None
    while True:
        kwargs: dict = {"channel": dm_channel, "limit": 200}
        if cursor:
            kwargs["cursor"] = cursor
        try:
            result = _api(client.conversations_history, **kwargs)
        except Exception as exc:
            logger.warning("Could not load DM history for message_log: %s", exc)
            break

        for msg in result.get("messages", []):
            ts = msg["ts"]
            if msg.get("thread_ts", ts) != ts:
                continue
            text = msg.get("text", "").strip()
            if not text:
                continue

            if msg.get("user") == user_id:
                _seen_dm_ts.add(ts)
                entries.append({
                    "thread_key": f"dm:{ts}",
                    "text": text,
                    "ts": ts,
                    "type": "user_message",
                })
            else:
                thread_key = digest_ts_to_key.get(ts)
                entries.append({
                    "thread_key": thread_key,
                    "text": text,
                    "ts": ts,
                    "type": "new",
                })
                # Fetch all replies inside this digest thread (bot updates + user replies)
                if thread_key and msg.get("reply_count", 0) > 0:
                    try:
                        replies = _api(
                            client.conversations_replies, channel=dm_channel, ts=ts
                        ).get("messages", [])
                        for reply in replies[1:]:  # skip root (already added)
                            reply_ts = reply["ts"]
                            reply_text = reply.get("text", "").strip()
                            if not reply_text:
                                continue
                            if reply.get("user") == user_id:
                                _seen_dm_ts.add(reply_ts)
                                entries.append({
                                    "thread_key": thread_key,
                                    "text": reply_text,
                                    "ts": reply_ts,
                                    "type": "user_message",
                                })
                            else:
                                entries.append({
                                    "thread_key": thread_key,
                                    "text": reply_text,
                                    "ts": reply_ts,
                                    "type": "update",
                                })
                    except Exception as exc:
                        logger.warning("Could not fetch DM thread replies for %s: %s", ts, exc)

        cursor = result.get("response_metadata", {}).get("next_cursor")
        if not cursor or not result.get("has_more"):
            break

    entries.sort(key=lambda e: e["ts"], reverse=True)
    message_log.extend(entries)
    logger.info("Loaded %d messages from DM history into log", len(entries))


# ---------------------------------------------------------------------------
# Core: surface or track a thread
# ---------------------------------------------------------------------------

def surface_thread(client, channel: str, thread_ts: str, backfill: bool = False) -> None:
    """Surface a thread to the user.

    backfill=False (default, real-time): post or update a DM digest message.
    backfill=True: only update internal state and message_log; no DM posting.
    """
    key = f"{channel}:{thread_ts}"
    existing = tracked_threads.get(key)

    # Never surface threads the user has muted
    if existing and existing.get("status") == "unimportant":
        return

    # During backfill: skip threads already tracked with a DM post — those are
    # covered by populate_message_log_from_dm.  Threads tracked but never
    # posted (backfill-only) fall through so their messages re-enter the log.
    if backfill and existing and existing.get("digest_ts"):
        return

    try:
        messages = _api(client.conversations_replies, channel=channel, ts=thread_ts).get("messages", [])
    except Exception as exc:
        logger.warning("Could not fetch thread %s: %s", thread_ts, exc)
        return

    if not messages:
        return

    if backfill:
        # Record the thread and populate message_log; never post to DM.
        last_ts = max(m["ts"] for m in messages)
        if not existing:
            tracked_threads[key] = {"status": "normal", "digest_ts": None, "last_ts": last_ts}
            save_state()
        text = "\n".join(m["text"] for m in messages if m.get("text", "").strip())
        if text:
            message_log.insert(0, {
                "thread_key": key,
                "text": text,
                "ts": thread_ts,
                "type": "backfill",
            })
        logger.info("Backfilled thread %s (%d messages)", key, len(messages))
        return

    # --- Real-time path: post or update a DM message ---

    dm_channel = resolve_dm_channel(client)
    if not dm_channel:
        return

    # Fingerprint reconciliation: find an existing DM post when digest_ts is missing
    if not existing or not existing.get("digest_ts"):
        fp = _fingerprint(messages[0].get("text", ""))
        match = _fingerprints.get(fp)
        if match and float(match["digest_ts"]) >= float(thread_ts):
            if existing:
                existing["digest_ts"] = match["digest_ts"]
                existing.setdefault("last_ts", match.get("last_ts", "0"))
            else:
                existing = {"status": "normal", "digest_ts": match["digest_ts"],
                            "last_ts": match.get("last_ts", "0")}
            tracked_threads[key] = existing
            save_state()
            logger.info("Reconciled %s via fingerprint (digest_ts=%s)", key, existing["digest_ts"])
        elif match:
            logger.warning(
                "Discarding fingerprint match for %s: digest_ts %s predates thread_ts %s",
                key, match["digest_ts"], thread_ts,
            )

    last_ts = existing["last_ts"] if existing else "0"
    new_messages = [m for m in messages if m["ts"] > last_ts and m.get("text", "").strip()]

    if not new_messages:
        return

    text = "\n".join(m["text"] for m in new_messages)
    has_dm_post = existing is not None and existing.get("digest_ts") is not None

    try:
        if not has_dm_post:
            response = client.chat_postMessage(
                channel=dm_channel,
                text=text,
                blocks=make_blocks(text, key, is_reply=False),
            )
            digest_ts = response["ts"]
            logger.info("Surfaced new thread %s", key)
            fp = _fingerprint(messages[0].get("text", ""))
            if fp:
                _fingerprints[fp] = {"digest_ts": digest_ts, "last_ts": "0"}
        else:
            client.chat_postMessage(
                channel=dm_channel,
                text=text,
                blocks=make_blocks(text, key, is_reply=True),
                thread_ts=existing["digest_ts"],
            )
            digest_ts = existing["digest_ts"]
            logger.info("Updated thread %s (+%d messages)", key, len(new_messages))
    except Exception as exc:
        if "cannot_reply_to_message" not in str(exc):
            logger.error("Failed to post to DM: %s", exc)
        else:
            logger.warning("Cannot reply to digest_ts %s for %s — skipping", existing["digest_ts"], key)
        return

    status = existing.get("status", "normal") if existing else "normal"
    tracked_threads[key] = {
        "status": status,
        "digest_ts": digest_ts,
        "last_ts": max(m["ts"] for m in new_messages),
    }
    save_state()
    message_log.insert(0, {
        "thread_key": key,
        "text": text,
        "ts": digest_ts,
        "type": "update" if has_dm_post else "new",
    })


# ---------------------------------------------------------------------------
# Startup: backfill channel history
# ---------------------------------------------------------------------------

def backfill_mentions(client) -> None:
    """Scan channel history for threads involving the watched user.

    Only updates internal state and message_log — no DM messages are posted.
    """
    user_id = resolve_user_id(client)
    if not user_id:
        return

    oldest = str(time.time() - BACKFILL_DAYS * 86400)

    channels: list[str] = []
    cursor = None
    while True:
        kwargs: dict = {"limit": 200, "types": "public_channel,private_channel", "exclude_archived": True}
        if cursor:
            kwargs["cursor"] = cursor
        result = _api(client.conversations_list, **kwargs)
        for ch in result.get("channels", []):
            if ch.get("is_member"):
                channels.append(ch["id"])
        cursor = result.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            break

    logger.info("Backfilling across %d channels (last %d days)", len(channels), BACKFILL_DAYS)

    for channel in channels:
        checked: set[str] = set()
        cursor = None
        while True:
            kwargs = {"channel": channel, "oldest": oldest, "limit": 200}
            if cursor:
                kwargs["cursor"] = cursor
            try:
                result = _api(client.conversations_history, **kwargs)
            except Exception as exc:
                logger.warning("Could not read history for %s: %s", channel, exc)
                break

            for msg in result.get("messages", []):
                thread_ts = msg.get("thread_ts") or msg["ts"]
                if thread_ts in checked:
                    continue
                checked.add(thread_ts)

                if is_mentioned(msg.get("text", ""), user_id) or msg.get("user") == user_id:
                    surface_thread(client, channel, thread_ts, backfill=True)
                    continue

                if msg.get("reply_count", 0) > 0:
                    try:
                        replies = _api(
                            client.conversations_replies,
                            channel=channel, ts=thread_ts, oldest=oldest,
                        ).get("messages", [])
                        for reply in replies[1:]:
                            if is_mentioned(reply.get("text", ""), user_id) or reply.get("user") == user_id:
                                surface_thread(client, channel, thread_ts, backfill=True)
                                break
                    except Exception as exc:
                        logger.warning("Could not fetch replies for %s: %s", thread_ts, exc)

            cursor = result.get("response_metadata", {}).get("next_cursor")
            if not cursor or not result.get("has_more"):
                break

        time.sleep(1)  # brief pause between channels to stay under burst limits

    logger.info("Backfill complete")
