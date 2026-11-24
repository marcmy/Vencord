# FixExpressionPickerFocus

Prevents Discord's FocusLock cleanup from refocusing a closed composer expression-picker button after Discord has already focused the message box. Enter then continues to work in the composer instead of reopening the picker.

Enabled by default in this fork. Rebuild and restart Discord to apply the patch; changing the plugin toggle also requires a restart.

The patch only skips return focus when the target is a closed expression-picker trigger belonging to the currently focused composer. It preserves normal restoration after Escape, outside clicks, reactions, other dialogs, and focus changes to another input or channel. It does not handle Enter, send messages, or force focus into an unfocused composer.

Run `pnpm test:expressionPickerFocus` for isolated browser regressions. Set `BROWSER_PATH` to your Chromium executable if necessary.
