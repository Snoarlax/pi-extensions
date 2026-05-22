"""Entry point."""

import logging
import os

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

import config  # ensures load_dotenv() runs before App() reads env vars
import handlers
import server
from core import backfill_mentions, build_digest_fingerprints, populate_message_log_from_dm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = App(token=os.environ["SLACK_BOT_TOKEN"])
handlers.register(app)

if __name__ == "__main__":
    if not config.WATCHED_USER_NAME:
        raise SystemExit("ERROR: set WATCHED_USER in your .env")
    logger.info("Watching '%s'", config.WATCHED_USER_NAME)
    server.start_http_server()
    build_digest_fingerprints(app.client)
    populate_message_log_from_dm(app.client)
    backfill_mentions(app.client)
    SocketModeHandler(app, os.environ["SLACK_APP_TOKEN"]).start()
