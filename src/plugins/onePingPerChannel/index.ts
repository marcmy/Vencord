/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { MessageJSON } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore, ReadStateStore, UserStore, WindowStore } from "@webpack/common";

const GUILD_MESSAGE_TYPES = new Set<ChannelType>([
    ChannelType.GUILD_TEXT,
    ChannelType.GUILD_ANNOUNCEMENT,
    ChannelType.GUILD_FORUM,
    ChannelType.GUILD_MEDIA,
    ChannelType.GUILD_VOICE,
    ChannelType.GUILD_STAGE_VOICE,
    ChannelType.PUBLIC_THREAD,
    ChannelType.PRIVATE_THREAD,
    ChannelType.ANNOUNCEMENT_THREAD
]);

const settings = definePluginSettings({
    allowMentions: {
        type: OptionType.BOOLEAN,
        description: "Receive notifications for @mentions even if the channel already has unread messages",
        default: false
    },
    allowRoleMentions: {
        type: OptionType.BOOLEAN,
        description: "Receive notifications for @role mentions even if the channel already has unread messages",
        default: false
    },
    allowEveryone: {
        type: OptionType.BOOLEAN,
        description: "Receive notifications for @everyone and @here even if the channel already has unread messages",
        default: false
    },
    pingCooldownMinutes: {
        type: OptionType.NUMBER,
        description: "Cooldown in minutes between pings for the same channel. 0 = only the first ping until read.",
        default: 0
    }
});

const pingState = new Map<string, { messageId?: string; timestamp: number }>();

function clearPingState(payload: any) {
    const channelId = payload?.channelId ?? payload?.channel_id ?? payload?.id ?? payload?.channel?.id;
    if (channelId) pingState.delete(channelId);

    const channels = payload?.channels;
    if (Array.isArray(channels)) {
        for (const entry of channels) {
            const entryId = entry?.channelId ?? entry?.channel_id ?? entry?.id ?? entry?.channel?.id;
            if (entryId) pingState.delete(entryId);
        }
    }
}

export default definePlugin({
    name: "OnePingPerChannel",
    description: "Only play the first notification per unread channel, with an optional cooldown. Reading the channel resets the limit.",
    authors: [Devs.marcmy],
    settings,
    patches: [
        {
            find: ".getDesktopType()===",
            replacement: [
                {
                    match: /(\i\.\i\.getDesktopType\(\)===\i\.\i\.NEVER)\)/,
                    replace: "$&if(!$self.shouldNotifyChannel(arguments[0]?.message))return;else "
                },
                {
                    match: /sound:(\i\?\i:void 0,volume:\i,onClick)/,
                    replace: "sound:!$self.shouldNotifyChannel(arguments[0]?.message)?undefined:$1"
                }
            ]
        },
        {
            find: ".SUPPRESS_NOTIFICATIONS))return!1",
            replacement: [
                {
                    match: /(\i\.getChannelId\(\)===\i)/,
                    replace: "$1&&(!$self.shouldApplyFocusOverride(arguments[0],arguments[1])||$self.isWindowFocused())"
                },
                {
                    match: /(\i===\i\.getChannelId\(\))/,
                    replace: "$1&&(!$self.shouldApplyFocusOverride(arguments[0],arguments[1])||$self.isWindowFocused())"
                },
                {
                    match: /SUPPRESS_NOTIFICATIONS\)\)return!1/,
                    replace: "$&;if(!$self.shouldNotifyChannel(arguments[0],arguments[1]))return!1"
                }
            ]
        }
    ],
    flux: {
        CHANNEL_ACK: clearPingState,
        BULK_ACK: clearPingState,
        CLEAR_OLDEST_UNREAD_MESSAGE: clearPingState,
        CHANNEL_DELETE: clearPingState
    },
    stop() {
        pingState.clear();
    },
    isWindowFocused() {
        return WindowStore.isFocused?.() ?? document.hasFocus();
    },
    resolveChannelId(messageOrChannel?: MessageJSON | string | { id?: string; channel_id?: string }, channelId?: string | { id?: string; channel_id?: string }) {
        if (typeof channelId === "string") return channelId;
        if (channelId?.id) return channelId.id;
        if (channelId?.channel_id) return channelId.channel_id;

        if (typeof messageOrChannel === "string") return messageOrChannel;
        if (messageOrChannel?.id && this.getChannel(messageOrChannel.id)) return messageOrChannel.id;
        return messageOrChannel?.channel_id;
    },
    getChannel(channelId?: string) {
        return channelId ? ChannelStore.getChannel(channelId) : null;
    },
    isGuildChannel(channelId?: string) {
        const channel = this.getChannel(channelId);
        return !!channel?.guild_id && GUILD_MESSAGE_TYPES.has(channel.type);
    },
    isPrivateMessageChannel(channelId?: string) {
        const type = this.getChannel(channelId)?.type;
        return type === ChannelType.DM || type === ChannelType.GROUP_DM;
    },
    shouldApplyFocusOverride(message?: MessageJSON | string | { id?: string; channel_id?: string }, channelId?: string | { id?: string; channel_id?: string }) {
        return this.isGuildChannel(this.resolveChannelId(message, channelId));
    },
    tryDelegateToOnePingPerDM(message?: MessageJSON) {
        if (!message) return void 0;

        const dmPlugin = (globalThis as any)?.Vencord?.Plugins?.plugins?.OnePingPerDM;
        if (!dmPlugin?.started || typeof dmPlugin.isPrivateChannelRead !== "function") return void 0;

        try {
            return !!dmPlugin.isPrivateChannelRead(message);
        } catch {
            return void 0;
        }
    },
    shouldNotifyChannel(message?: MessageJSON, channelId?: string | { id?: string }) {
        const resolvedChannelId = this.resolveChannelId(message, channelId);
        if (!resolvedChannelId) return true;

        if (this.isPrivateMessageChannel(resolvedChannelId)) {
            return this.tryDelegateToOnePingPerDM(message) ?? true;
        }

        const channel = this.getChannel(resolvedChannelId);
        if (!channel?.guild_id || !GUILD_MESSAGE_TYPES.has(channel.type)) return true;

        const currentUserId = UserStore.getCurrentUser()?.id;
        const allowBypass = (
            (settings.store.allowMentions && currentUserId && message?.mentions?.some(m => m.id === currentUserId)) ||
            (settings.store.allowRoleMentions && message?.mention_roles?.length) ||
            (settings.store.allowEveryone && message?.mention_everyone)
        );

        const messageId = message?.id;
        if (!messageId) return true;

        const cooldownMinutes = Math.max(0, settings.store.pingCooldownMinutes ?? 0);
        if (cooldownMinutes <= 0) {
            if (allowBypass) return true;

            const oldestUnreadId = ReadStateStore.getOldestUnreadMessageId?.(resolvedChannelId);
            if (!oldestUnreadId) return true;

            return messageId === oldestUnreadId;
        }

        const existingState = pingState.get(resolvedChannelId);
        if (existingState?.messageId === messageId) return true;

        const oldestUnreadId = ReadStateStore.getOldestUnreadMessageId?.(resolvedChannelId);
        if (!oldestUnreadId) return true;

        if (messageId === oldestUnreadId) {
            pingState.set(resolvedChannelId, { messageId, timestamp: Date.now() });
            return true;
        }

        const cooldownMs = cooldownMinutes * 60 * 1000;
        const now = Date.now();

        if (allowBypass || !existingState || now - existingState.timestamp >= cooldownMs) {
            pingState.set(resolvedChannelId, { messageId, timestamp: now });
            return true;
        }

        return false;
    }
});
