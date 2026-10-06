# Scout — Conference & Meeting Observer

Scout is an autonomous conference and meeting capture system. It joins sessions via your Google Calendar, records audio with real-time transcription (Deepgram), captures slide changes via computer vision (Claude Vision), and produces structured output you can feed into your own analysis pipeline.

Built as a Chrome extension + Node.js companion server.

> Before using Scout, confirm you have permission to record or automate entry to each session. See [PRIVACY.md](PRIVACY.md) for data flow, local storage, and retention details.

## What It Does

1. **Capture** — Chrome extension grabs tab audio and video. Audio streams to Deepgram for real-time transcription. Video frames are captured on slide transitions and sent to Claude Vision for text extraction.
2. **Calendar integration** — Connect your Google Calendar. Scout shows today's schedule, lets you queue events for capture, and can auto-join meetings at the scheduled time.
3. **Auto-join** — In "auto" mode, Scout opens the meeting tab, fills your display name, clicks Join, and starts capturing — hands-free. Platform-specific scripts for Zoom web, with a generic fallback for other platforms.
4. **Identity guard** — If something goes wrong during auto-join (waiting room, CAPTCHA, unexpected form), Scout silently exits rather than exposing your identity. Three-tier escalation: silent exit → polite apology → bot disclosure.
5. **Replay capture** — Capture YouTube replays offline. Downloads captions, extracts slide-change frames via ffmpeg scene detection, processes through Claude Vision.
6. **Dashboard** — Browser-based status page showing active captures, today's schedule, event queue, and recent sessions.

## Output Per Session

Each capture creates a directory under `~/Scout-captures/`:

```
session-id/
  transcript.json          — timestamped transcript segments
  frames/frame-001.jpg     — captured slide-change frames
  slide-content.json       — Claude Vision extracted text per frame
  combined.md              — merged timeline (slides + transcript)
  combined-output.json     — structured JSON for downstream analysis
```

## Prerequisites

- **Node.js** (v18+)
- **Google Chrome** (for the extension)
- **ffmpeg** (for replay capture only)
- **yt-dlp** (for replay capture only)

Scout is currently supported on macOS and Windows. It is a local tool, not a hosted service.

## Setup

### 1. Clone and install

```bash
git clone <this-repo>
cd scout
cd server && npm install
```

### 2. Configure API keys

Copy the example environment file and add your keys:

```bash
cp .env.example .env
```

Generate a local access token and put it in `SCOUT_LOCAL_TOKEN`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edit `.env`:

| Variable | Where to get it | Required |
|----------|----------------|----------|
| `DEEPGRAM_API_KEY` | [deepgram.com](https://deepgram.com) — create a project, generate an API key | Yes |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) — for slide content extraction via Claude Vision | No (slides won't be OCR'd) |
| `GOOGLE_CLIENT_ID` | Google Cloud Console (see below) | No (calendar won't work) |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console (see below) | No (calendar won't work) |
| `GOOGLE_ACCOUNTS` | Comma-separated account labels (e.g. `personal,work`) | No (defaults to `personal`) |
| `DISPLAY_NAME` | The name shown when auto-joining meetings | No (defaults to `Scout User`) |
| `PORT` | Server port | No (defaults to `8765`) |
| `SCOUT_LOCAL_TOKEN` | A random 32+ character local access token | Yes |

**Important:** `DISPLAY_NAME` should NOT be a real person's name. Use something like `Scout`, `Notes`, or `Session Recorder`. See [IDENTITY-GUARD.md](IDENTITY-GUARD.md) for why.

### 3. Google Calendar setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable the **Google Calendar API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Add `http://localhost:8765/auth/callback` as an authorized redirect URI
7. Copy the Client ID and Client Secret to your `.env`
8. Complete the OAuth consent-screen setup and, while the app is in testing, add your Google account as a test user.

### 4. Start the server

```bash
cd server
npm start
```

You should see:

```
Scout companion server running on port 8765
Dashboard: http://localhost:8765/dashboard
```

### 5. Connect your calendar

Open `http://localhost:8765/dashboard?token=YOUR_SCOUT_LOCAL_TOKEN` once. The token is exchanged for a local browser session and removed from the address bar. Then visit `/auth/login?account=personal` from that same browser session. Use `localhost` here because it matches the Google OAuth callback.

### 6. Load the Chrome extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` directory from this repo
5. Open the extension's **Details** → **Extension options**, then enter `http://127.0.0.1:8765` and the same `SCOUT_LOCAL_TOKEN` from `.env`
6. The Scout icon appears in your toolbar

### 7. Start capturing

- **Manual:** Click the Scout icon, find your tab, click **Capture**
- **Scheduled:** Open the authenticated dashboard, find an event in Today's Schedule, click **Queue Capture**
- **Auto-join:** Queue an event with auto mode — Scout handles the rest

## Auto-Start on Login

So Scout is ready whenever your computer is:

- **Mac:** `bash startup/install-mac.sh` — installs a LaunchAgent
- **Windows:** Run `startup\install-windows.bat` — creates a per-user Task Scheduler entry

## Replay Capture

Capture YouTube replays without live playback:

```bash
node server/replay.js <youtube-url>
```

Options:
- `--threshold N` — Scene detection sensitivity (default: 0.6, lower = more frames)
- `--interval N` — Sample one frame every N seconds instead of scene detection
- `--keep-video` — Keep the downloaded video file
- `--no-vision` — Skip Claude Vision slide extraction
- `--concurrency N` — Parallel Vision API calls (default: 5)
- `--resume <dir>` — Resume from an existing session directory

Or via the server API:

```bash
curl -X POST http://127.0.0.1:8765/capture/replay \
  -H "Content-Type: application/json" \
  -H "X-Scout-Token: YOUR_SCOUT_LOCAL_TOKEN" \
  -d '{"url": "https://youtube.com/watch?v=..."}'
```

## Server API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dashboard` | GET | HTML status dashboard |
| `/status` | GET | Server health + active sessions |
| `/auth/login?account=NAME` | GET | Start Google OAuth flow |
| `/auth/callback` | GET | OAuth redirect handler |
| `/auth/status` | GET | Which accounts are connected |
| `/calendar/search?q=TERM` | GET | Search calendar events (next 14 days) |
| `/today` | GET | Today's events with meeting links |
| `/events/queue` | POST | Queue an event for capture |
| `/events/queued` | GET | List queued events |
| `/events/queue/:id` | DELETE | Remove a queued event |
| `/events/queue/:id` | PATCH | Update a queued event (e.g. change mode) |
| `/schedule` | GET | Events ready to open (polled by extension) |
| `/calendar/create` | POST | Create a Google Calendar event |
| `/captures` | GET | List completed capture sessions |
| `/capture/replay` | POST | Start a YouTube replay capture |

## Architecture

```
Google Calendar API
        |
  Companion Server (Node.js, port 8765)
  ├─ Calendar OAuth + event search
  ├─ Event queue + scheduler
  ├─ Deepgram WebSocket (audio → transcript)
  ├─ Claude Vision (frames → slide content)
  ├─ Replay capture (yt-dlp + ffmpeg)
  └─ Status dashboard
        |
  Chrome Extension (Manifest V3)
  ├─ Tab audio capture → PCM → WebSocket → server
  ├─ Tab video capture → frame diff → JPEG → server
  ├─ Auto-join content scripts (Zoom, generic)
  ├─ Identity guard (3-tier escalation)
  └─ Schedule polling + notifications
        |
  Output: ~/Scout-captures/
```

### Audio pipeline

Tab audio → `chrome.tabCapture` → offscreen document → AudioContext (16kHz) → PCM int16 → WebSocket → server → Deepgram Nova-2 → transcript

### Video pipeline

Tab video → canvas frame grab (5s interval) → pixel diff (160×90 thumbnail) → if >5% change → full-res JPEG → server → Claude Vision Haiku → slide text

## Recovery

The extension handles crashes automatically:
- **Service worker restart** — cleans up orphaned sessions from `chrome.storage.local`
- **Tab crash/close** — health check every 60s detects dead tabs
- **Server disconnect** — offscreen document retries WebSocket up to 5 times

## Using with Claude Code

Scout includes Claude Code skills for AI-assisted analysis of captured sessions:

- **`/triage`** — Quick evaluation of a captured session. Produces a verdict (GOLD / WORTH A LOOK / SKIP / GO WATCH THIS) and a triage card.
- **`/extract`** — Deep 6-lens analysis of a GOLD-rated session: executive sound bites, frameworks, AI transformation playbook, martech intelligence, contrarian takes, attributed quotes.

These skills are templates — customize the evaluation criteria in `.claude/skills/` to match your professional context.

## Security model

The server binds only to `127.0.0.1`; it is not reachable from your network. Its dashboard and API require `SCOUT_LOCAL_TOKEN`, and the extension stores the token in its local Chrome storage. Do not share your `.env`, `~/.scout/`, or `~/Scout-captures/` folders.

## License

MIT
