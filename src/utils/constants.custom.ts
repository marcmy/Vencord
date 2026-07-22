/*
 * Vencord, a Discord client mod
 * Copyright (c) 2022 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs as UpstreamDevs } from "./constants";

export * from "./constants";

/**
 * Fork-only contributors live outside upstream constants so sync merges cannot
 * silently remove their typed author entries.
 */
export const Devs = /* #__PURE__*/ Object.freeze({
    ...UpstreamDevs,
    marcmy: {
        name: "marcmy",
        id: 0n,
        badge: false
    }
});
