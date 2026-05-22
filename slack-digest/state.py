"""
All mutable runtime state and persistence.

File format (v2):
{
  "tracked": {
    "C:ts": {
      "status":    "normal" | "on_board" | "closed" | "unimportant",
      "digest_ts": str | null,
      "last_ts":   str
    }
  }
}

Older formats (separate ignored/job_board/job_board_closed lists) are
migrated automatically on first load.
"""

import json
import logging

from config import SEEN_THREADS_FILE

logger = logging.getLogger(__name__)

# In-memory message log, most recent first.
message_log: list[dict] = []


def _migrate(key: str, val: dict, ignored: set, job_board: set, closed: set) -> dict:
    if "status" in val:
        return val
    if key in job_board:
        status = "on_board"
    elif key in closed:
        status = "closed"
    elif key in ignored:
        status = "unimportant"
    else:
        status = "normal"
    return {"status": status, "digest_ts": val.get("digest_ts"), "last_ts": val.get("last_ts", "0")}


def _load() -> dict:
    if not SEEN_THREADS_FILE.exists():
        return {}
    try:
        data = json.loads(SEEN_THREADS_FILE.read_text())
    except Exception as exc:
        logger.warning("Could not load state: %s", exc)
        return {}

    # Very old set-based format (list of keys)
    if isinstance(data, list):
        return {k: {"status": "normal", "digest_ts": None, "last_ts": "0"} for k in data}

    ignored = set(data.get("ignored", []))
    job_board = set(data.get("job_board", []))
    closed = set(data.get("job_board_closed", []))

    # "tracked" key present → v1 or v2 format; otherwise the whole dict is tracked
    raw = data.get("tracked", data)

    threads: dict[str, dict] = {}
    for key, val in raw.items():
        if not isinstance(val, dict):
            continue
        threads[key] = _migrate(key, val, ignored, job_board, closed)

    # Keys that only appeared in side-sets
    for key in ignored - threads.keys():
        threads[key] = {"status": "unimportant", "digest_ts": None, "last_ts": "0"}
    for key in job_board - threads.keys():
        threads[key] = {"status": "on_board", "digest_ts": None, "last_ts": "0"}
    for key in closed - threads.keys():
        threads[key] = {"status": "closed", "digest_ts": None, "last_ts": "0"}

    return threads


tracked_threads: dict[str, dict] = _load()


def save_state() -> None:
    try:
        SEEN_THREADS_FILE.write_text(json.dumps({"tracked": tracked_threads}, indent=2))
    except Exception as exc:
        logger.error("Could not save state: %s", exc)
