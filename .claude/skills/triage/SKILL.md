---
name: triage
description: Triage a captured session — quick evaluation + slide extraction decision. Produces a triage card for the Scout brief.
---

# /triage

Evaluate a single session and produce a triage card. This is the per-session building block that feeds into a Scout brief.

## Input

The user provides one of:
1. A Scout capture directory (from `~/Scout-captures/`) — use `combined.md` or `combined-output.json`
2. A transcript (pasted text or file path)
3. Optionally: session title, speaker name(s), session format

## Evaluation

Read the transcript with the user's POV in mind (see CLAUDE.md "Your POV" section). Ask:
- Does this speaker have frameworks the user can deploy professionally?
- Is there strategic insight at the executive/board level?
- Is there practical transformation content (not theoretical)?
- Does the speaker have credibility to back their claims?
- Is this a product demo in disguise?

Produce a triage card:

```
### [Session Title]
**Speaker:** [Name, Title, Company]
**Format:** [keynote / fireside chat / panel / demo / other]
**Verdict:** [GOLD / WORTH A LOOK / SKIP / GO WATCH THIS]

**Why:** [2-3 sentences — what landed and what didn't]

**Key signal(s):**
- [The 1-3 most valuable things, if any]

**Slides:** [Extracted N keepers / Scout captured N frames / Not extracted — reason]
```

### Verdict Guide

- **GOLD** — Has frameworks, mental models, or strategic insights that are directly usable. Recommend `/extract` for deep analysis.
- **WORTH A LOOK** — Has useful pieces but isn't a must-capture. Pull the best bits into the brief.
- **SKIP** — Product demo, fluff, or nothing new. Brief reason why.
- **GO WATCH THIS** — Too rich, nuanced, or conversational to reduce to a summary. Watch the replay.

## Slide Extraction Decision Tree

When working from Scout captures, frames are already extracted in `frames/` and OCR'd in `slide-content.json`. Classify and file keepers directly — skip Gates 1-2.

When working from other transcript sources (no Scout capture), run the full gate sequence:

### Gate 1 — Session Format

Assess from the agenda and transcript:
- **Single speaker presenting** (keynote, talk) → likely has slides → proceed to Gate 2
- **Panel discussion** (3+ speakers, Q&A) → unlikely meaningful slides → **skip**
- **Fireside chat** (interviewer + guest) → unlikely → **skip**
- **Product demo** → has screens but not framework slides → **skip** unless transcript shows framework content

### Gate 2 — Transcript Visual Cues

Scan for phrases signaling the speaker references visual content:
- "let me share my screen" / "I'll share my screen"
- "you can see" / "as you can see" / "if you look at"
- "this slide" / "on this slide" / "next slide"
- "this diagram" / "this chart" / "this framework"
- "on the left" / "on the right" / "at the top" / "at the bottom"
- "here's an example" / "I'll show you" / "let me show"

Count distinct cue instances:
- **5+ cues** → high confidence of visual content → proceed to Gate 3
- **1-4 cues** → limited visual content → proceed with caution
- **0 cues** → no visual content → **skip**

### Gate 3 — Proceed

Download the video and extract frames.

### Extraction Procedure (non-Scout sources)

If you have a video URL, use the replay capture:
```bash
node server/replay.js <url> --threshold 0.3
```

Or manually extract frames with ffmpeg:

**Strategy A — Cue-phrase timestamps** (preferred when transcript has timestamps):
```bash
ffmpeg -y -ss "$TIMESTAMP" -i "$VIDEO" -frames:v 1 -q:v 2 "frame-$N.jpg"
```

**Strategy B — Scene detection** (fallback):
```bash
ffmpeg -i "$VIDEO" -vf "select='gt(scene,0.3)',showinfo" -vsync vfr "frame-%03d.jpg" 2>&1
```

### Frame Classification

Classify each frame by viewing it:
- **KEEP:** Framework diagrams, 2x2 matrices, process maps, data charts with real metrics, architecture diagrams, numbered playbooks
- **SKIP:** Title slides, speaker bios, product UI, transition slides, "thank you" slides, talking-head frames, blurry frames

The test: *"Would you pull this up in a professional conversation?"*

File keepers with descriptive names:
`YYYY-MM-DD-scout-<speaker-lastname>-slide-<description>.jpg`

## After Triage

When triage is complete for an event, produce a brief:

```
# [Event Name] — Scout Brief
**Date:** YYYY-MM-DD
**Sessions reviewed:** N

## Top Picks
[Ranked list — why each matters]

## Worth a Look
[Sessions with useful pieces but not gold]

## Skip
[Sessions that didn't land — brief reason]

## "Go Watch This"
[Sessions to experience yourself]
```

For GOLD items, note that `/extract` is the next step for deep analysis.

## Guidelines

- Speed over depth. This is triage, not analysis. If it's GOLD, `/extract` does the deep work.
- Be honest about what didn't land. "Polished presentation but fundamentally a product demo" is a valid assessment.
- Seven strong slide images beat fifteen mediocre ones.
- When in doubt about a verdict, lean toward WORTH A LOOK — let the user make the final call.
