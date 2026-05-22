"""Register all Slack action and event handlers onto the app instance."""

import logging

from blocks import action_buttons, make_blocks, swap_action_block, truncate, thread_state
from core import add_dm_message_to_log, _resolve_dm_thread_key, surface_thread
from slack_helpers import get_channel_id, is_mentioned, resolve_dm_channel, resolve_user_id
from state import tracked_threads, save_state

logger = logging.getLogger(__name__)


def _set_status(thread_key: str, status: str) -> None:
    entry = tracked_threads.setdefault(thread_key, {"digest_ts": None, "last_ts": "0"})
    entry["status"] = status
    save_state()


def register(app) -> None:

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    @app.action("mark_unimportant")
    def handle_mark_unimportant(ack, body, client):
        ack()
        try:
            thread_key = body["actions"][0]["value"]
            _set_status(thread_key, "unimportant")
            logger.info("Thread %s marked as unimportant", thread_key)

            msg = body.get("message", {})
            new_blocks = []
            for block in msg.get("blocks", []):
                if block.get("type") == "section":
                    full_text = block.get("text", {}).get("text", "")
                    new_blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": truncate(full_text)}})
                elif block.get("type") != "actions":
                    new_blocks.append(block)
            new_blocks.append(action_buttons(thread_key, "unimportant"))

            client.chat_update(
                channel=get_channel_id(body),
                ts=msg["ts"],
                blocks=new_blocks,
                text=truncate(msg.get("text", "")),
            )
        except Exception as exc:
            logger.error("Error in mark_unimportant: %s", exc, exc_info=True)

    @app.action("track_again")
    def handle_track_again(ack, body, client):
        ack()
        try:
            thread_key = body["actions"][0]["value"]
            msg = body.get("message", {})
            digest_ts = msg["ts"]
            source_channel, thread_ts = thread_key.rsplit(":", 1)

            messages = client.conversations_replies(channel=source_channel, ts=thread_ts).get("messages", [])
            if not messages:
                return

            full_text = "\n".join(m["text"] for m in messages if m.get("text", "").strip())
            entry = tracked_threads.setdefault(thread_key, {"digest_ts": digest_ts, "last_ts": "0"})
            entry["status"] = "normal"
            entry.setdefault("digest_ts", digest_ts)
            entry["last_ts"] = max(m["ts"] for m in messages)
            save_state()
            logger.info("Thread %s restored to tracking", thread_key)

            client.chat_update(
                channel=get_channel_id(body),
                ts=digest_ts,
                blocks=make_blocks(full_text, thread_key, is_reply=False),
                text=full_text,
            )
        except Exception as exc:
            logger.error("Error in track_again: %s", exc, exc_info=True)

    @app.action("add_to_job_board")
    def handle_add_to_job_board(ack, body, client):
        ack()
        try:
            thread_key = body["actions"][0]["value"]
            _set_status(thread_key, "on_board")
            logger.info("Thread %s added to job board", thread_key)

            msg = body.get("message", {})
            client.chat_update(
                channel=get_channel_id(body),
                ts=msg["ts"],
                blocks=swap_action_block(msg.get("blocks", []), thread_key, "on_board"),
                text=msg.get("text", ""),
            )
        except Exception as exc:
            logger.error("Error in add_to_job_board: %s", exc, exc_info=True)

    @app.action("close_job_board")
    def handle_close_job_board(ack, body, client):
        ack()
        try:
            thread_key = body["actions"][0]["value"]
            _set_status(thread_key, "closed")
            logger.info("Thread %s closed on job board", thread_key)

            msg = body.get("message", {})
            client.chat_update(
                channel=get_channel_id(body),
                ts=msg["ts"],
                blocks=swap_action_block(msg.get("blocks", []), thread_key, "closed"),
                text=msg.get("text", ""),
            )
        except Exception as exc:
            logger.error("Error in close_job_board: %s", exc, exc_info=True)

    @app.action("reopen_job_board")
    def handle_reopen_job_board(ack, body, client):
        ack()
        try:
            thread_key = body["actions"][0]["value"]
            _set_status(thread_key, "on_board")
            logger.info("Thread %s reopened on job board", thread_key)

            msg = body.get("message", {})
            client.chat_update(
                channel=get_channel_id(body),
                ts=msg["ts"],
                blocks=swap_action_block(msg.get("blocks", []), thread_key, "on_board"),
                text=msg.get("text", ""),
            )
        except Exception as exc:
            logger.error("Error in reopen_job_board: %s", exc, exc_info=True)

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------

    @app.event("message")
    def handle_message(event, client):
        user_id = resolve_user_id(client)
        if not user_id:
            return

        channel = event["channel"]

        # Messages sent by the user into the DM are logged for HTTP polling
        # but don't trigger thread surfacing
        if channel == resolve_dm_channel(client):
            text = event.get("text", "").strip()
            if text and event.get("user") == user_id:
                ts = event["ts"]
                thread_ts = event.get("thread_ts")
                if thread_ts and thread_ts != ts:
                    thread_key = _resolve_dm_thread_key(thread_ts)
                else:
                    thread_key = f"dm:{ts}"
                add_dm_message_to_log(ts, text, thread_key)
            return

        thread_ts = event.get("thread_ts") or event["ts"]
        key = f"{channel}:{thread_ts}"

        if is_mentioned(event.get("text", ""), user_id) or event.get("user") == user_id or key in tracked_threads:
            surface_thread(client, channel, thread_ts)

    @app.event("reaction_added")
    def handle_reaction_added(event, client):
        user_id = resolve_user_id(client)
        if not user_id:
            return
        item = event.get("item", {})
        if item.get("type") != "message":
            return

        channel = item["channel"]
        msg_ts = item["ts"]
        reaction = event.get("reaction", "")
        dm_channel = resolve_dm_channel(client)

        # :robot_face: on a DM digest message → promote that thread to job board
        if reaction == "robot_face" and channel == dm_channel:
            thread_key = next(
                (k for k, v in tracked_threads.items() if v.get("digest_ts") == msg_ts),
                None,
            )
            if thread_key:
                _set_status(thread_key, "on_board")
                logger.info("Thread %s added to job board via :robot_face: on DM", thread_key)
                try:
                    result = client.conversations_history(
                        channel=dm_channel, latest=msg_ts, limit=1, inclusive=True
                    )
                    dm_msg = next((m for m in result.get("messages", []) if m["ts"] == msg_ts), None)
                    if dm_msg:
                        client.chat_update(
                            channel=dm_channel,
                            ts=msg_ts,
                            blocks=swap_action_block(dm_msg.get("blocks", []), thread_key, "on_board"),
                            text=dm_msg.get("text", ""),
                        )
                except Exception as exc:
                    logger.warning("Could not update DM buttons for %s: %s", thread_key, exc)
            return

        # :robot_face: on a channel message (any user) → surface + add to job board
        if reaction == "robot_face" and channel != dm_channel:
            try:
                result = client.conversations_replies(channel=channel, ts=msg_ts, limit=1)
                root = result["messages"][0] if result.get("messages") else None
            except Exception as exc:
                logger.warning("Could not fetch thread for :robot_face: at %s: %s", msg_ts, exc)
                return
            if not root:
                return
            thread_ts = root["ts"]
            key = f"{channel}:{thread_ts}"
            # Set status before surfacing so the new DM post renders on_board buttons
            _set_status(key, "on_board")
            surface_thread(client, channel, thread_ts)
            logger.info("Thread %s added to job board via :robot_face: reaction", key)
            # If the DM post already existed, update its buttons
            entry = tracked_threads.get(key)
            if entry and entry.get("digest_ts"):
                try:
                    result = client.conversations_history(
                        channel=dm_channel, latest=entry["digest_ts"], limit=1, inclusive=True
                    )
                    dm_msg = next(
                        (m for m in result.get("messages", []) if m["ts"] == entry["digest_ts"]),
                        None,
                    )
                    if dm_msg:
                        client.chat_update(
                            channel=dm_channel,
                            ts=entry["digest_ts"],
                            blocks=swap_action_block(dm_msg.get("blocks", []), key, "on_board"),
                            text=dm_msg.get("text", ""),
                        )
                except Exception as exc:
                    logger.warning("Could not update DM buttons for %s: %s", key, exc)
            return

        # Any other reaction: only care about the watched user, not the DM channel
        if event["user"] != user_id or channel == dm_channel:
            return

        logger.info("Reaction by watched user in %s at %s", channel, msg_ts)
        try:
            result = client.conversations_replies(channel=channel, ts=msg_ts, limit=1)
            root = result["messages"][0] if result.get("messages") else None
        except Exception as exc:
            logger.warning("Could not fetch thread for reaction at %s in %s: %s", msg_ts, channel, exc)
            return
        if not root:
            logger.warning("No root message found for reaction at %s in %s", msg_ts, channel)
            return
        surface_thread(client, channel, root["ts"])
