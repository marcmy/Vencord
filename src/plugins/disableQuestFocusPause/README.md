# DisableQuestFocusPause

Local-only Vencord plugin that prevents Discord quest videos from pausing when the client loses focus.

## What it does

- Detects the quest video modal heuristically
- Spoofs visible/focused state while that modal is open
- Blocks blur and visibility events during quest playback
- Attempts to resume the video if Discord pauses it anyway

## Caveat

This is intentionally a local workaround, not an upstream-safe plugin. Discord does not expose a stable public quest API for this flow, so detection is based on the current modal structure and copy.
