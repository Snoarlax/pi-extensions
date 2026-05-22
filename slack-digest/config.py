import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

WATCHED_USER_NAME: str = os.environ.get("WATCHED_USER", "")
WATCHED_GROUPS: list[str] = [
    g.strip() for g in os.environ.get("WATCHED_GROUPS", "").split(",") if g.strip()
]
SEEN_THREADS_FILE: Path = Path(os.environ.get("SEEN_THREADS_FILE", "seen_threads.json"))
BACKFILL_DAYS: int = int(os.environ.get("BACKFILL_DAYS", "7"))
HTTP_PORT: int = int(os.environ.get("HTTP_PORT", "7001"))
TRUNCATE_LEN: int = 60
