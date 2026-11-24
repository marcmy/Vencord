# SplitLargeMessages

Local custom Vencord plugin for messages that exceed Discord's 2,000-character message limit.

## Notes
- Prefers splitting on blank lines, then newlines, then spaces.
- Includes a `Leading Blank Line Mode` setting for split chunks (`Trim`, `Invisible guard`, `Visible marker`).
- Attachments and stickers are only sent with the first chunk.
- Pasting more than 2,000 characters opens an editable prompt showing the exact number of messages the paste will become.
- The paste prompt offers `Paste X Messages`, `Paste as File`, and `Cancel`, in that order.
- `Paste as File` calls Discord's original upload flow and creates the normal `message.txt` attachment instead of routing back through the splitter.
- Composer formatting can be slightly different from the final sent output in some long-paste cases (for example blank lines), but sent chunks preserve spacing correctly.
- Includes the existing local composer UI polish for Discord's Nitro upsell, negative counter, and auto-`message.txt` preview artifacts.
