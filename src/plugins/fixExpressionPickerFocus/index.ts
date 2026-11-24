/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "FixExpressionPickerFocus",
    description: "Keeps focus in the message box after choosing an emoji, sticker, or GIF.",
    authors: [Devs.marcmy],
    enabledByDefault: true,
    requiresRestart: true,

    patches: [{
        find: ".containerRef,{disableReturn:",
        replacement: {
            match: /\i\?\.isConnected\?(\i)\.focus\(\):\1\.focus\(\{preventScroll:!0\}\)/,
            replace: "$self.keepComposerFocus($1)||($&)"
        }
    }],

    keepComposerFocus(target: HTMLElement) {
        try {
            if (!(target instanceof HTMLElement) || target.getAttribute("aria-expanded") !== "false") return false;

            const form = target.closest("form");
            const active = target.ownerDocument.activeElement;
            if (!form || !(active instanceof HTMLElement) || !active.isContentEditable || !form.contains(active)) return false;

            const pickerId = form.querySelector("[class*='emojiButton_'][aria-controls]")?.getAttribute("aria-controls");
            // All three composer picker buttons control the same expression-picker dialog.
            return !!pickerId && target.getAttribute("aria-controls") === pickerId;
        } catch (error) {
            console.error("[FixExpressionPickerFocus] Failed checking return focus", error);
            return false;
        }
    }
});
