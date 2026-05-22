"""Local HTTP server for polling job board threads.

Endpoints:
  GET /         — all messages from message_log (from, n)
  GET /threads  — one object per on_board thread with all text combined (from, n)
"""

import json
import logging
import threading
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from config import HTTP_PORT
from state import message_log, tracked_threads

logger = logging.getLogger(__name__)


def _aggregate_threads() -> list[dict]:
    """Return one entry per on_board thread with all texts combined chronologically.

    User DM replies linked to a thread are merged into that thread's text.
    """
    # Accumulate text for every thread key — message_log is newest-first so
    # reversing gives oldest-first insertion order within each thread.
    per_thread: dict[str, list[str]] = defaultdict(list)
    for entry in reversed(message_log):
        key = entry.get("thread_key")
        if key:
            per_thread[key].append(entry["text"])

    # One entry per on_board thread, newest-first.
    seen: set[str] = set()
    result: list[dict] = []
    for entry in message_log:
        key = entry.get("thread_key")
        if not key or key in seen:
            continue
        if tracked_threads.get(key, {}).get("status") == "on_board":
            seen.add(key)
            result.append({
                "thread_key": key,
                "ts": entry["ts"],
                "text": "\n".join(per_thread[key]),
            })
    return result


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        start = int(params.get("from", ["0"])[0])
        n = int(params.get("n", ["20"])[0])

        if parsed.path == "/threads":
            data = _aggregate_threads()[start:start + n]
        else:
            data = message_log[start:start + n]

        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def start_http_server() -> None:
    server = HTTPServer(("localhost", HTTP_PORT), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    logger.info("HTTP server listening on http://localhost:%d", HTTP_PORT)
