# slack-digest

A Slack bot that monitors threads involving a watched user and surfaces them as DMs with interactive controls and a local HTTP API.

## Setup

### 1. Install dependencies

```bash
uv sync
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-…`) from your Slack app |
| `SLACK_APP_TOKEN` | App-level token (`xapp-…`) for Socket Mode |
| `WATCHED_USER` | Display name of the user to track (e.g. `Jane Doe`) |
| `WATCHED_GROUPS` | Comma-separated group handles to treat as mentions (e.g. `team-eng,oncall`) |
| `BACKFILL_DAYS` | How many days of history to scan on startup (default: `7`) |
| `HTTP_PORT` | Port for the local API server (default: `7001`) |
| `SEEN_THREADS_FILE` | Path to the state file (default: `seen_threads.json`) |

### 3. Run

```bash
uv run python bot.py
```

---

## How it works

On startup the bot:
1. Scans DM history to rebuild fingerprints and the message log
2. Backfills the last `BACKFILL_DAYS` of channel history to discover relevant threads (no DMs are sent during backfill)
3. Begins listening for real-time events via Socket Mode

A thread is surfaced when:
- The watched user is @-mentioned (direct or via a watched group)
- The watched user sent a message in the thread
- The watched user reacted to a message in the thread
- The watched user reacted with `:robot_face:` on a message -> this also adds the thread to the job board automatically

---

## Thread statuses

| Status | Meaning |
|---|---|
| `normal` | Tracked, shown in DM, not on job board |
| `on_board` | Added to the job board; appears in `GET /threads` |
| `closed` | Removed from job board but can be reopened |
| `unimportant` | Muted; no further DMs; excluded from API |

Statuses are controlled by the action buttons on each DM digest message or by reacting with `:robot_face:`.

---

## DM commands

Send these in the bot DM (only works for the watched user):

| Command | Effect |
|---|---|
| `/new-thread <text>` | Create a new manually-tracked thread with the given text |

---

## HTTP API

The bot exposes a local server at `http://localhost:7001` (configurable via `HTTP_PORT`).

### `GET /`

All messages in the log, newest first.

Query params:
- `from` — offset (default `0`)
- `n` — page size (default `20`)

### `GET /threads`

One object per `on_board` thread with all messages concatenated, newest thread first.

Query params:
- `from` — offset (default `0`)
- `n` — page size (default `20`)

---

## Running on startup (macOS)

A LaunchAgent is installed at:

```
~/Library/LaunchAgents/com.snoarlax.slack-digest.plist
```

Logs are written to:

```
~/Library/Logs/slack-digest/stdout.log
~/Library/Logs/slack-digest/stderr.log
```

### Useful commands

```bash
# Tail live logs
tail -f ~/Library/Logs/slack-digest/stderr.log

# Stop the service
launchctl unload ~/Library/LaunchAgents/com.snoarlax.slack-digest.plist

# Start the service
launchctl load ~/Library/LaunchAgents/com.snoarlax.slack-digest.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.snoarlax.slack-digest.plist && \
launchctl load ~/Library/LaunchAgents/com.snoarlax.slack-digest.plist

# Check status (shows PID and last exit code)
launchctl list | grep slack-digest
```

---

## State

Thread statuses are persisted in `seen_threads.json` (or the path set by `SEEN_THREADS_FILE`). The file is written on every status change and is safe to inspect or back up while the bot is running.
