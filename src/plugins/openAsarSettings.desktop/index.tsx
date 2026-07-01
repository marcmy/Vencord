/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { MainSettingsIcon } from "@components/Icons";
import { SettingsTab } from "@components/settings/tabs/BaseTab";
import SettingsPlugin from "@plugins/_core/settings";
import { Devs } from "@utils/constants";
import { removeFromArray } from "@utils/misc";
import definePlugin from "@utils/types";
import { Forms, React } from "@webpack/common";

const ENTRY_KEY = "vencord_openasar";

function openOpenAsarSettings() {
    DiscordNative.ipc.send("DISCORD_UPDATED_QUOTES", "o");
}

function OpenAsarSettingsPage() {
    React.useEffect(openOpenAsarSettings, []);

    return (
        <SettingsTab>
            <Forms.FormTitle tag="h2">OpenAsar</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 16 }}>
                OpenAsar uses a separate settings window. This Vencord entry remains available when OpenAsar's own Discord sidebar injection breaks.
            </Forms.FormText>
            <Button onClick={openOpenAsarSettings}>Open OpenAsar Settings</Button>
        </SettingsTab>
    );
}

export default definePlugin({
    name: "OpenAsarSettings",
    description: "Adds a reliable OpenAsar settings entry to Vencord's settings section",
    authors: [Devs.Ven],
    enabledByDefault: true,

    start() {
        if (SettingsPlugin.customEntries.some(entry => entry.key === ENTRY_KEY)) return;

        SettingsPlugin.customEntries.push({
            key: ENTRY_KEY,
            title: "OpenAsar",
            Component: OpenAsarSettingsPage,
            Icon: MainSettingsIcon
        });
    },

    stop() {
        removeFromArray(SettingsPlugin.customEntries, entry => entry.key === ENTRY_KEY);
    }
});
