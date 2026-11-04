# DisableQuestFocusPause

Local-only Vencord plugin that prevents Discord quest videos from pausing when the client loses focus and adds a draggable in-Discord mini-player.

## What it does

- Detects the quest video modal heuristically
- Spoofs visible/focused state while that modal is open
- Blocks blur and visibility events during quest playback
- Attempts to resume the video if Discord pauses it anyway
- Adds a **Minimize video** button to the quest modal
- Keeps the original video element mounted while displaying it as a floating, resizable player
- Adds a **Restore** button to return to the normal quest modal
- Restores changed styles, removes injected controls, and stops observers/listeners when disabled

## How to test

1. Start a Discord video quest and wait for the quest modal to show its video.
2. Click **Minimize video** in the top-right area of the modal.
3. Move or resize the floating player and try navigating Discord channels and typing in a message box.
4. Click **Restore** and verify the original modal and playback are intact.
5. Close the quest or disable the plugin and check that no floating UI or invisible backdrop remains.

## Caveat

This is intentionally a local workaround, not an upstream-safe plugin. Discord does not expose a stable public quest API for this flow, so detection is based on the current modal structure and copy. The mini-player keeps Discord's original React modal and video mounted rather than cloning the stream. Changes to modal structure, stacking contexts or focus trapping may require further adjustments. In particular, keyboard focus handling and quest progress need to be checked with an actual live quest; static TypeScript checks cannot confirm either.
