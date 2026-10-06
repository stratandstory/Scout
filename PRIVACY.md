# Privacy and Recording Notice

Scout is a local-first tool. Its companion server listens only on `127.0.0.1`, and its local API requires a token you create. Captures, calendar OAuth tokens, and queued meeting details remain on your computer by default.

## Data that leaves your computer

- **Deepgram:** live tab audio is sent to Deepgram only while transcription is enabled.
- **Anthropic:** captured slide-change images are sent to Anthropic only when `ANTHROPIC_API_KEY` is configured. Omit that key or use replay `--no-vision` to keep images local.
- **Google:** if calendar integration is enabled, Scout reads events from the Google account you explicitly connect. The requested scope also permits creating calendar events through the documented API.

Scout does not include telemetry, analytics, or a hosted Scout service.

## Your responsibilities

Before recording, automatically joining, or processing a meeting, confirm that you have permission and that the meeting platform's terms and applicable laws allow it. Auto-join is intentionally opt-in; queued events default to notification-only mode. Use a generic `DISPLAY_NAME`, and never enter personal information into an unexpected meeting form.

## Local retention and deletion

Captures are stored in `~/Scout-captures/`; OAuth tokens and the event queue are stored in `~/.scout/`. New files are created with owner-only permissions. Scout does not automatically delete completed captures: delete session folders and revoke Google access when you no longer need them.
