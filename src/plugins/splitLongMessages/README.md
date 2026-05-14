# SplitLongMessages
Splits outgoing messages longer than 2000 characters into multiple messages.

## Notes
- Prefers splitting on blank lines, then newlines, then spaces
- Includes a `Leading Blank Line Mode` setting for split chunks (`Trim`, `Invisible guard`, `Visible marker`)
- Attachments and stickers are only sent with the first chunk
- Handles Discord's long-text auto `message.txt` upload path by sending split text directly instead of requiring manual file handling
- Upstream-safe scope: no DOM manipulation or UI-hiding behavior
