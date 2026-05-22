"""Block Kit builders and text utilities."""

from config import TRUNCATE_LEN
from state import tracked_threads


def truncate(text: str) -> str:
    return text[:TRUNCATE_LEN] + "..." if len(text) > TRUNCATE_LEN else text


def thread_state(thread_key: str) -> str:
    """Return the display state for a thread key."""
    return tracked_threads.get(thread_key, {}).get("status", "normal")


def action_buttons(thread_key: str, state: str) -> dict:
    """
    Build an actions block for a given thread state.

    States:
      normal       — tracked, not on job board
      on_board     — currently on the job board
      closed       — was on job board, now closed (can reopen)
      unimportant  — muted (only Track again shown)
    """
    if state == "unimportant":
        return {
            "type": "actions",
            "elements": [{
                "type": "button",
                "text": {"type": "plain_text", "text": "Track again"},
                "action_id": "track_again",
                "value": thread_key,
            }],
        }

    elements: list[dict] = [{
        "type": "button",
        "text": {"type": "plain_text", "text": "Mark as unimportant"},
        "action_id": "mark_unimportant",
        "value": thread_key,
        "style": "danger",
    }]

    if state == "normal":
        elements.append({
            "type": "button",
            "text": {"type": "plain_text", "text": "Add to job board"},
            "action_id": "add_to_job_board",
            "value": thread_key,
            "style": "primary",
        })
    elif state == "on_board":
        elements.append({
            "type": "button",
            "text": {"type": "plain_text", "text": "Close"},
            "action_id": "close_job_board",
            "value": thread_key,
        })
    elif state == "closed":
        elements.append({
            "type": "button",
            "text": {"type": "plain_text", "text": "Reopen"},
            "action_id": "reopen_job_board",
            "value": thread_key,
        })

    return {"type": "actions", "elements": elements}


def make_blocks(text: str, thread_key: str, is_reply: bool) -> list[dict]:
    """Build a full message block list for a surfaced thread."""
    blocks: list[dict] = [{"type": "section", "text": {"type": "mrkdwn", "text": text}}]
    if not is_reply:
        blocks.append(action_buttons(thread_key, thread_state(thread_key)))
    return blocks


def swap_action_block(blocks: list[dict], thread_key: str, state: str) -> list[dict]:
    """Replace the actions block in an existing block list with updated buttons."""
    return [b for b in blocks if b.get("type") != "actions"] + [action_buttons(thread_key, state)]
