/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { addGlobalContextMenuPatch, findGroupChildrenByChildId, removeGlobalContextMenuPatch, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { copyWithToast } from "@utils/discord";
import { Margins } from "@utils/margins";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { ChannelStore, Constants, Forms, GuildRoleStore, Menu, Modal, openModal, React, RestAPI, Select, showToast, SnowflakeUtils, TextArea, TextInput, UserStore, useState } from "@webpack/common";
import type { ReactElement } from "react";

type CopyDirection = "up" | "down";

const COPY_MENU_IDS = ["copy", "copy-text", "copy-text-selection"];
const MessageDisplayCompact = getUserSettingLazy<boolean>("textAndImages", "messageDisplayCompact")!;
const DAY_NAMES = "(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)";
const DUPLICATE_DATE_LINE = new RegExp(`^\\[\\d{1,2}:\\d{2}\\s?[AP]M\\]${DAY_NAMES}, `, "i");
const HEADER_WITH_DUPLICATE_DATE = new RegExp(`^(.*?\\b\\d{1,2}:\\d{2}\\s?[AP]M)${DAY_NAMES}, .*$`, "i");

const UI_LINES = new Set([
    "Quick Mention",
    "Add Reaction",
    "Reply",
    "Forward",
    "More",
    "Click to react"
]);

const settings = definePluginSettings({
    defaultMessageCount: {
        type: OptionType.NUMBER,
        description: "Default number of messages to fetch for Copy Nearby Messages",
        default: 100
    },
    includeTimestamps: {
        type: OptionType.BOOLEAN,
        description: "Include timestamps in copied conversation text",
        default: true
    },
    includeAttachments: {
        type: OptionType.BOOLEAN,
        description: "Include attachment URLs in copied conversation text",
        default: true
    }
});

function getSelectionText() {
    return document.getSelection()?.toString() ?? "";
}

function isReactionEmojiLine(line: string) {
    return /^:[^:\s][^:\n]*:$/.test(line);
}

function cleanSelectionText(raw: string) {
    const lines = raw
        .replace(/\r\n?/g, "\n")
        .replace(/\u00a0/g, " ")
        .split("\n")
        .map(line => line.trim());

    const cleaned: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (!line) {
            if (cleaned.length && cleaned[cleaned.length - 1] !== "") cleaned.push("");
            continue;
        }

        line = line.replace(HEADER_WITH_DUPLICATE_DATE, "$1");

        if (DUPLICATE_DATE_LINE.test(line)) continue;
        if (UI_LINES.has(line)) {
            if (line === "Click to react" && isReactionEmojiLine(cleaned[cleaned.length - 1] ?? ""))
                cleaned.pop();
            continue;
        }

        if (isReactionEmojiLine(line) && lines[i + 1] === "Click to react") continue;

        cleaned.push(line);
    }

    return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function copyCleanSelection() {
    const selection = getSelectionText();
    if (!selection.trim()) return;

    try {
        // This follows the same browser copy path as Ctrl+C, which Discord already handles better.
        if (document.execCommand("copy")) {
            showToast("Copied selection", "success");
            return;
        }
    } catch { }

    await copyWithToast(cleanSelectionText(selection), "Copied cleaned selection");
}

function replaceCopyMenuItem(group: Array<ReactElement<any> | null | undefined>) {
    const selection = getSelectionText();
    if (!selection.trim()) return;

    for (let i = 0; i < group.length; i++) {
        const item = group[i];
        if (!item?.props || !COPY_MENU_IDS.includes(item.props.id)) continue;

        group[i] = React.cloneElement(item, {
            action: copyCleanSelection
        });
    }
}

function patchSelectedCopy(_navId: string, children: Array<ReactElement<any> | null | undefined>) {
    const group = findGroupChildrenByChildId(COPY_MENU_IDS, children);
    if (group) replaceCopyMenuItem(group);
}

function getAuthorName(message: any) {
    const author = message.author;
    if (!author) return "Unknown";

    const user = UserStore.getUser(author.id);
    return user?.globalName ?? user?.username ?? author.globalName ?? author.global_name ?? author.username ?? "Unknown";
}

function getTimestamp(message: any) {
    const timestamp = message.timestamp instanceof Date
        ? message.timestamp
        : message.timestamp
            ? new Date(message.timestamp)
            : new Date(SnowflakeUtils.extractTimestamp(message.id));

    return timestamp.toLocaleString(undefined, {
        hour: "numeric",
        minute: "2-digit"
    });
}

function getTimestampMs(message: any) {
    if (message.timestamp instanceof Date) return message.timestamp.getTime();
    if (message.timestamp) return new Date(message.timestamp).getTime();
    return SnowflakeUtils.extractTimestamp(message.id);
}

function getGuildId(channelId: string) {
    return ChannelStore.getChannel(channelId)?.guild_id;
}

function formatMentions(content: string, channelId: string) {
    const guildId = getGuildId(channelId);

    return content
        .replace(/<@!?(\d+)>/g, (_, id) => {
            const user = UserStore.getUser(id);
            return user ? `@${user.globalName ?? user.username}` : `@${id}`;
        })
        .replace(/<#(\d+)>/g, (_, id) => {
            const channel = ChannelStore.getChannel(id);
            return channel ? `#${channel.name}` : `#${id}`;
        })
        .replace(/<@&(\d+)>/g, (_, id) => {
            const role = guildId ? GuildRoleStore.getRole(guildId, id) : null;
            return role ? `@${role.name}` : `@${id}`;
        })
        .replace(/<a?:([^:]+):\d+>/g, ":$1:");
}

function formatMessageBody(message: any, channelId: string) {
    const parts = [formatMentions(message.content ?? "", channelId).trim()];

    if (settings.store.includeAttachments) {
        for (const attachment of message.attachments ?? []) {
            const url = attachment.url ?? attachment.proxy_url;
            if (url) parts.push(`[Attachment: ${url}]`);
        }
    }

    return parts.filter(Boolean).join("\n");
}

function formatCompactMessage(message: any, channelId: string) {
    const author = getAuthorName(message);
    const body = formatMessageBody(message, channelId);
    const prefix = settings.store.includeTimestamps
        ? `[${getTimestamp(message)}]${author}: `
        : `${author}: `;

    return body ? prefix + body : prefix.trim();
}

function formatConversation(messages: any[], channelId: string) {
    if (MessageDisplayCompact.getSetting()) {
        return messages.map(message => formatCompactMessage(message, channelId)).join("\n");
    }

    const lines: string[] = [];
    let lastAuthorId: string | undefined;
    let lastMinute = -1;

    for (const message of messages) {
        const authorId = message.author?.id;
        const minute = Math.floor(getTimestampMs(message) / 60000);
        const body = formatMessageBody(message, channelId);

        if (authorId !== lastAuthorId || minute !== lastMinute) {
            const header = settings.store.includeTimestamps
                ? `${getAuthorName(message)} — ${getTimestamp(message)}`
                : getAuthorName(message);

            lines.push(header);
            lastAuthorId = authorId;
            lastMinute = minute;
        }

        if (body) lines.push(body);
    }

    return lines.join("\n");
}

function sortMessages(messages: any[]) {
    return [...messages].sort((a, b) => SnowflakeUtils.extractTimestamp(a.id) - SnowflakeUtils.extractTimestamp(b.id));
}

async function fetchMessages(channelId: string, anchorId: string, direction: CopyDirection, count: number) {
    if (count <= 0) return [];

    const messages: any[] = [];
    let cursor = anchorId;
    let remaining = count;
    const queryKey = direction === "up" ? "before" : "after";

    while (remaining > 0) {
        const limit = Math.min(100, remaining);
        const res = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: {
                limit,
                [queryKey]: cursor
            },
            retries: 2
        });

        const batch = res.body ?? [];
        if (!batch.length) break;

        messages.push(...batch);
        remaining -= batch.length;
        cursor = direction === "up"
            ? batch[batch.length - 1].id
            : batch[0].id;

        if (batch.length < limit) break;
    }

    return sortMessages(messages);
}

async function getConversationText(channelId: string, anchorMessage: Message, direction: CopyDirection, count: number) {
    const remaining = Math.max(0, count - 1);
    const messages = [
        anchorMessage,
        ...(await fetchMessages(channelId, anchorMessage.id, direction, remaining))
    ];

    return formatConversation(sortMessages(messages), channelId);
}

async function getLatestConversationText(channelId: string, count: number) {
    const res = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query: {
            limit: Math.min(100, count)
        },
        retries: 2
    });

    return formatConversation(sortMessages(res.body ?? []), channelId);
}

function clampMessageCount(value: string | number) {
    const count = Number(value);
    if (!Number.isFinite(count)) return settings.store.defaultMessageCount;
    return Math.max(1, Math.min(500, Math.round(count)));
}

function openCopyMessagesModal(message: Message) {
    openModal(props => (
        <ErrorBoundary>
            <CopyMessagesModal
                modalProps={props}
                message={message}
            />
        </ErrorBoundary>
    ));
}

function CopyMessagesModal({ modalProps, message }: { modalProps: any; message: Message; }) {
    const [count, setCount] = useState(String(settings.store.defaultMessageCount));
    const [direction, setDirection] = useState<CopyDirection>("up");
    const [text, setText] = useState("");
    const [loading, setLoading] = useState(false);

    async function load() {
        setLoading(true);
        try {
            setText(await getConversationText(message.channel_id, message, direction, clampMessageCount(count)));
        } finally {
            setLoading(false);
        }
    }

    return (
        <Modal
            {...modalProps}
            title="Copy Nearby Messages"
            size="lg"
            actions={[
                {
                    text: loading ? "Loading..." : "Load",
                    variant: "secondary",
                    disabled: loading,
                    onClick: load
                },
                {
                    text: "Copy All",
                    variant: "primary",
                    disabled: !text,
                    onClick: () => copyWithToast(text, "Copied conversation text")
                }
            ]}
        >
            <Forms.FormTitle tag="h5">Messages</Forms.FormTitle>
            <TextInput
                value={count}
                onChange={setCount}
                placeholder="100"
            />

            <Forms.FormTitle tag="h5" className={Margins.top16}>Direction</Forms.FormTitle>
            <Select
                options={[
                    { label: "Up from clicked message", value: "up" },
                    { label: "Down from clicked message", value: "down" }
                ]}
                select={setDirection}
                isSelected={value => value === direction}
                serialize={String}
                closeOnSelect
            />

            <Forms.FormTitle tag="h5" className={Margins.top16}>Text</Forms.FormTitle>
            <TextArea
                className="vc-better-chat-copy-textarea"
                value={text}
                onChange={setText}
                placeholder="Load messages to preview and edit the copied text."
            />
        </Modal>
    );
}

async function copyPreviousMessages(message: Message, count = settings.store.defaultMessageCount) {
    await copyWithToast(
        await getConversationText(message.channel_id, message, "up", clampMessageCount(count)),
        "Copied conversation text"
    );
}

async function copyLatestMessages(channelId: string, count = settings.store.defaultMessageCount) {
    await copyWithToast(
        await getLatestConversationText(channelId, clampMessageCount(count)),
        "Copied conversation text"
    );
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message, channel }: { message?: Message; channel?: Channel; }) => {
    if (!message) return;

    const group = findGroupChildrenByChildId("copy-text", children) ?? children;

    group.splice(group.findIndex(item => item?.props?.id === "copy-text") + 1, 0,
        <Menu.MenuItem
            id="vc-better-chat-copy"
            label="Copy Nearby Messages"
        >
            <Menu.MenuItem
                id="vc-better-chat-copy-open"
                label="Open Copy Window"
                action={() => openCopyMessagesModal(message)}
            />
            <Menu.MenuItem
                id="vc-better-chat-copy-previous"
                label={`Copy Up ${settings.store.defaultMessageCount}`}
                action={() => copyPreviousMessages(message)}
            />
            {channel && (
                <Menu.MenuItem
                    id="vc-better-chat-copy-channel"
                    label={`Copy Latest ${settings.store.defaultMessageCount} in Channel`}
                    action={() => copyLatestMessages(channel.id)}
                />
            )}
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "BetterChatCopy",
    description: "Fixes noisy selected-text copy and adds tools for copying nearby conversation text.",
    tags: ["Chat", "Utility"],
    authors: [Devs.marcmy],
    dependencies: ["UserSettingsAPI"],
    settings,

    start() {
        addGlobalContextMenuPatch(patchSelectedCopy);
    },

    stop() {
        removeGlobalContextMenuPatch(patchSelectedCopy);
    },

    contextMenus: {
        "message": messageContextMenuPatch
    }
});
