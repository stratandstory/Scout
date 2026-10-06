---
name: extract
description: Deep analysis of a GOLD-rated session through executive intelligence lenses. Run after /triage rates something GOLD.
---

# /extract

Deep analysis of a conference session transcript for executive intelligence. This is the step after `/triage` — when a session earns GOLD, `/extract` pulls out the deployable frameworks, sound bites, and playbook items.

## Input

The user provides a transcript in one of these ways:
1. **Scout capture directory** — from `~/Scout-captures/`, use `combined.md` or `combined-output.json`
2. **Pasted text** — the user copies a transcript into chat
3. **File path** — the user points to a saved transcript file

The user may also provide a session title and speaker name(s) as arguments (e.g., `/extract "From Models to Harnesses" Martin Kihn`). Parse these if given.

## Multi-Session Transcripts

If the transcript covers a full day (multiple sessions in one recording), segment it using the conference agenda and produce **one analysis file per session**. Use speaker changes, topic shifts, and approximate timestamps to find the boundaries.

If segmentation is ambiguous, ask the user to confirm the boundaries rather than guessing.

File each session separately (e.g., `2026-09-08-extract-from-models-to-harnesses.md`). Also produce a one-page `YYYY-MM-DD-extract-day-N-rollup.md` summarizing the day's best finds across all sessions — top 5 sound bites, top 3 frameworks, the single most contrarian take.

## Analysis Lenses

Analyze the transcript through these six lenses. Extract only what's genuinely valuable — empty sections are better than padded ones.

### 1. Executive Sound Bites
Reusable phrases at the "don't fall in love with the solution" caliber. Lines you'd drop in consulting conversations, decks, and posts. Must be quotable, pithy, and attributable. Format: the quote, then speaker name/title/company in parentheses.

### 2. Frameworks & Mental Models
Named conceptual tools — 2x2s, spectrums, stage models, taxonomies, or reframes that organize thinking. Only include if the framework has genuine explanatory power. Describe the framework, not just name it.

### 3. AI Transformation Playbook
What applies to corporate AI transformation — organizational change, adoption patterns, governance, capability building, ROI frameworks, failure modes.

### 4. Martech / GTM Intelligence
B2B marketing technology, go-to-market strategy, revenue operations, demand gen, ABM, attribution, stack architecture.

### 5. Contrarian Takes
Things that challenge conventional thinking. Especially valuable if the speaker has credibility to back the contrarian position. State the conventional wisdom being challenged, then the contrarian position.

### 6. Speaker-Attributed Quotes
Direct quotes with speaker name, title, and company for use in decks and conversations. Only capture quotes that are genuinely compelling — not every sentence.

## Output Format

Produce a structured markdown note:

```
# [Session Title]
**Speaker(s):** [Name, Title, Company]
**Date:** [YYYY-MM-DD]
**Event:** [Conference/event name]

## Synthesis
[One paragraph: what this session was really about — the thesis, not the topic]

## Executive Sound Bites
- "[quote]" — Speaker Name, Title, Company

## Frameworks & Mental Models
### [Framework Name]
[Description of the framework and why it has explanatory power]

## AI Transformation Playbook
- [Bullet points of applicable insights]

## Martech / GTM Intelligence
- [Bullet points]

## Contrarian Takes
- **Conventional wisdom:** [X] → **Contrarian position:** [Y] (Speaker Name)

## Speaker-Attributed Quotes
- "[quote]" — Speaker Name, Title, Company
  [One line of context for when to use this quote]

## Key Slides
| # | Image | What It Shows | Why It Matters |
|---|-------|---------------|----------------|
| 1 | filename.jpg | One-line description | Why this is useful |

*If slide extraction was skipped:*
> **Slides:** Not extracted — [reason]

## Bottom Line
[2-3 sentences: why this session matters for your work]
```

## Filing

Save the analysis to your configured output directory.

**Naming:** `YYYY-MM-DD-extract-<session-slug>.md`
where `<session-slug>` is a kebab-case summary of the session title (e.g., `from-models-to-harnesses`)

Never overwrite an existing file. If a file exists at the target path, add `-v2`, `-v3` etc.

## Slide Extraction

The slide extraction decision tree is shared with `/triage`. When `/triage` has already extracted slides, don't re-extract — reference the existing files.

### Decision Tree: Should I Extract Slides?

**Gate 1 — Session Format**
- **Single speaker presenting** → likely has slides → proceed to Gate 2
- **Panel discussion** → unlikely → **skip**
- **Fireside chat** → unlikely → **skip**
- **Product demo** → **skip** unless transcript shows framework content

**Gate 2 — Transcript Visual Cues**
Scan for: "let me share my screen," "you can see," "this slide," "this diagram," "this chart," "this framework," spatial references, "here's an example."

- **5+ cues** → proceed
- **1-4 cues** → proceed with caution
- **0 cues** → **skip**

**Gate 3 — Proceed with extraction.**

### Frame Classification
- **KEEP:** Framework diagrams, 2x2 matrices, process maps, data charts, architecture diagrams, numbered playbooks
- **SKIP:** Title slides, bio slides, product UI demos, transition slides, "thank you" slides, talking-head frames, blurry frames

The test: *"Would you pull this up in a professional conversation?"*

File keepers: `YYYY-MM-DD-extract-<speaker-lastname>-slide-<description>.jpg`

Clean up — delete temporary video files and non-keeper frames.

## Guidelines

- Don't pad. If a session yields 2 sound bites and 1 framework, that's the output.
- Prefer direct quotes over paraphrase when the speaker said it well.
- Be specific about attribution — "Martin Kihn, SVP Strategy, Salesforce" not just "a speaker."
- If the transcript has auto-transcription errors, note quality issues but work with what's there.
- Don't include the raw transcript — this is analysis, not archival.
- Never overwrite an existing file. If a file already exists at the target path, add `-v2`, `-v3` etc.
- For slide extraction: when in doubt, skip. Seven strong images beat fifteen mediocre ones.
