# Scout Identity Guard

Scout joins meetings autonomously. When things go wrong — waiting rooms, chat prompts, CAPTCHAs, unexpected forms — it must protect the operator's identity at all costs.

**Current behavior:** Scout never posts to meeting chat or sends a bot disclosure. On any unexpected state, it closes the tab and stops capture. This avoids leaving an observable trail or accidentally interacting with the wrong UI.

## Hard Rules

1. **Never reveal the operator's name.** Not in chat, not in forms, not in error messages. This rule is absolute across all tiers.
2. **Never fill unexpected forms.** If Scout encounters a form it didn't expect (survey, "who are you?", registration), skip it entirely. Only fill the display-name field on the known join flow.
3. **DISPLAY_NAME must never be a real person's name.** The `.env` value should be a generic handle (e.g. `Scout`, `Notes`, `Session Recorder`). The server default is `Scout User` — this is fine.

## Three-Tier Escalation

When Scout hits a roadblock after joining (or attempting to join), escalate through these tiers in order. Each tier reveals a little more, but never the operator's identity.

### Tier 1: Silent Exit

**Trigger:** Any unexpected state — waiting room, CAPTCHA, login wall, "state your name" prompt, unrecognized UI.

**Action:** Close the tab. No message, no interaction. Just leave.

**Implementation:** `chrome.tabs.remove(tabId)` + clean up session state.

### Tier 2: Disabled (documented for historical context only)

**Trigger:** Tier 1 failed (tab can't be closed, or Scout is already visible to participants — e.g., in a chat window, unmuted, or on camera).

**Message:**
> Apologies — I joined this session by mistake. I can't figure out how to leave. Please feel free to remove me.

**Rules:**
- Post this in chat only if a chat input is detected and Scout is already visible.
- Do not answer follow-up questions. If prompted again, repeat the message once, then go silent.
- Keep trying to close the tab in parallel.

### Tier 3: Disabled (documented for historical context only)

**Trigger:** Tier 2 didn't resolve it. Scout is stuck, visible, and people are asking questions.

**Message:**
> I'm a bot — I'm sorry about this. Please remove me from the session. Apologies for the disruption.

**Rules:**
- This is the last message Scout ever sends in a session. After posting it, go completely silent.
- Continue attempting to close the tab.
- Never elaborate. Never name the operator. Never explain what the bot does.

## Detection: When to Trigger the Guard

The guard activates when any of these are detected after auto-join injection:

- **Waiting room:** No join succeeded after `MAX_WAIT_MS` and page contains waiting-room indicators
- **CAPTCHA or bot check:** Any `iframe` or element matching known CAPTCHA patterns
- **Login/registration wall:** Form fields asking for email, password, company, or other identity beyond display name
- **Chat visibility:** Scout's display name appears in a participant list or chat
- **Unexpected form fields:** Any input asking for information beyond the display-name field in the join flow
- **Direct address in chat:** Messages directed at the Scout display name or "who are you?" type questions

## Implementation Notes

The guard logic lives in `content-scripts/identity-guard.js`. Both `zoom-join.js` and `generic-join.js` work alongside it. The background worker (`background.js`) has guard awareness for tab-level cleanup.
