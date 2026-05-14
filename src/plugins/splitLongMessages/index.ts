/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageObject, MessageOptions } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import {
    DraftStore,
    DraftType,
    FluxDispatcher,
    MessageActions,
    UploadAttachmentStore,
    UploadManager
} from "@webpack/common";

const MAX_MESSAGE_LENGTH = 2000;
const LEADING_GUARD = "\u200b";
const LEADING_BLANK_LINE_GUARD = "\u2800";
const VISIBLE_BLANK_LINE_MARKER = "·";
const HANDLED_FLAG = "__vencordSplitLongMessagesHandled";
const LOG_PREFIX = "[SplitLongMessages]";

const DraftManager = findByPropsLazy("clearDraft");

type LeadingBlankLineMode = "trim" | "invisible" | "visible_marker";

type SeparatorKind = "double_newline" | "single_newline" | "space" | "none";

type AutoTextUpload = {
    showLargeMessageDialog?: boolean;
    filename?: string;
    mimeType?: string;
    item?: {
        file?: File;
    };
};

const settings = definePluginSettings({
    leadingBlankLineMode: {
        type: OptionType.SELECT,
        description: "How to handle blank lines at the start of split chunks",
        options: [
            { label: "Trim", value: "trim", default: true },
            { label: "Invisible guard (best effort)", value: "invisible" },
            { label: "Visible marker (exact spacing)", value: "visible_marker" }
        ]
    }
});

function warn(message: string, error?: unknown) {
    console.warn(LOG_PREFIX, message, error);
}

function findSplitIndex(text: string): { index: number; separatorKind: SeparatorKind } {
    const doubleNewline = text.lastIndexOf("\n\n");
    if (doubleNewline > -1) return { index: doubleNewline, separatorKind: "double_newline" };

    const singleNewline = text.lastIndexOf("\n");
    if (singleNewline > -1) return { index: singleNewline, separatorKind: "single_newline" };

    const space = text.lastIndexOf(" ");
    if (space > -1) return { index: space, separatorKind: "space" };

    return { index: text.length, separatorKind: "none" };
}

function getLeadingGuardInfo(text: string, mode: LeadingBlankLineMode) {
    let extra = 0;
    const leadingNewlines = text.match(/^\n+/)?.[0].length ?? 0;
    const needsPrefixIndentGuard = leadingNewlines === 0 && /^[\t ]/.test(text);
    const needsIndentGuardAfterNewlines = leadingNewlines > 0 && /^[\n]+[\t ]/.test(text);

    const leadingBlankLinePrefix =
        mode === "invisible" ? LEADING_BLANK_LINE_GUARD
            : mode === "visible_marker" ? VISIBLE_BLANK_LINE_MARKER
                : "";

    if (leadingBlankLinePrefix) {
        extra += leadingNewlines * leadingBlankLinePrefix.length;
    }
    if (needsPrefixIndentGuard) extra += LEADING_GUARD.length;
    if (needsIndentGuardAfterNewlines) extra += LEADING_GUARD.length;

    return {
        extra,
        apply(chunk: string) {
            if (leadingNewlines > 0) {
                let rest = chunk.slice(leadingNewlines);
                if (/^[\t ]/.test(rest)) {
                    rest = LEADING_GUARD + rest;
                }
                if (leadingBlankLinePrefix) {
                    return `${`${leadingBlankLinePrefix}\n`.repeat(leadingNewlines)}${rest}`;
                }
                return chunk;
            }

            return needsPrefixIndentGuard ? LEADING_GUARD + chunk : chunk;
        }
    };
}

function splitContent(content: string, maxLen = MAX_MESSAGE_LENGTH, mode: LeadingBlankLineMode): string[] {
    const chunks: string[] = [];
    let remaining = content;
    const preserveLeadingBlankLines = mode !== "trim";

    while (remaining.length > 0) {
        const guardInfo = getLeadingGuardInfo(remaining, mode);
        const limit = maxLen - guardInfo.extra;

        if (remaining.length <= limit) {
            chunks.push(guardInfo.apply(remaining));
            break;
        }

        const slice = remaining.slice(0, limit);
        const { index, separatorKind } = findSplitIndex(slice);

        let splitAt = index;
        let takeLength = splitAt;
        let dropLength = splitAt;

        if (splitAt <= 0) {
            splitAt = limit;
            takeLength = splitAt;
            dropLength = splitAt;
        } else if (separatorKind === "space") {
            takeLength = Math.min(splitAt + 1, slice.length);
            dropLength = takeLength;
        } else if (separatorKind === "single_newline") {
            if (preserveLeadingBlankLines) {
                dropLength = splitAt;
            } else {
                takeLength = Math.min(splitAt + 1, slice.length);
                dropLength = takeLength;
            }
        } else if (separatorKind === "double_newline") {
            if (preserveLeadingBlankLines) {
                dropLength = splitAt;
            } else {
                takeLength = Math.min(splitAt + 2, slice.length);
                dropLength = takeLength;
            }
        }

        chunks.push(guardInfo.apply(slice.slice(0, takeLength)));
        remaining = remaining.slice(dropLength);
    }

    return chunks;
}

function buildFollowUpOptions(options: MessageOptions | undefined) {
    if (!options) return undefined;

    return {
        ...options,
        uploads: undefined,
        stickers: undefined,
        replyOptions: options.replyOptions
            ? {
                messageReference: null,
                allowedMentions: options.replyOptions.allowedMentions
            }
            : options.replyOptions
    } satisfies MessageOptions;
}

function isAutoTextUpload(upload: unknown): upload is AutoTextUpload {
    const candidate = upload as AutoTextUpload | undefined;
    if (!candidate) return false;

    if (candidate.showLargeMessageDialog) return true;

    const filename = candidate.filename ?? candidate.item?.file?.name;
    if (filename !== "message.txt") return false;

    const mimeType = candidate.mimeType ?? candidate.item?.file?.type;
    return !mimeType || mimeType === "text/plain";
}

function stripAutoTextUploads(options: MessageOptions | undefined) {
    if (!options?.uploads?.length) return;

    const filtered = options.uploads.filter(upload => !isAutoTextUpload(upload));
    if (filtered.length !== options.uploads.length) {
        options.uploads = filtered;
    }
}

function hasAutoTextUpload(options: MessageOptions | undefined) {
    return !!options?.uploads?.some(isAutoTextUpload);
}

async function readAutoTextUpload(options: MessageOptions | undefined): Promise<string | null> {
    const upload = options?.uploads?.find(isAutoTextUpload);
    const file = upload?.item?.file;

    if (!file?.text) return null;

    try {
        return await file.text();
    } catch (error) {
        warn("Failed reading auto message.txt upload text", error);
        return null;
    }
}

async function resolveLongMessageContent(channelId: string, msg: MessageObject, options: MessageOptions | undefined) {
    if (msg.content.length > MAX_MESSAGE_LENGTH) {
        return { content: msg.content, fromAutoTextUpload: false };
    }

    const uploadText = await readAutoTextUpload(options);
    if (uploadText && uploadText.length > MAX_MESSAGE_LENGTH) {
        return { content: uploadText, fromAutoTextUpload: true };
    }

    const draft = DraftStore.getDraft(channelId, DraftType.ChannelMessage);
    if (draft?.length > MAX_MESSAGE_LENGTH) {
        return { content: draft, fromAutoTextUpload: hasAutoTextUpload(options) };
    }

    const liveUploads = UploadAttachmentStore?.getUploads?.(channelId, DraftType.ChannelMessage) ?? [];
    const liveAutoUpload = liveUploads.find(isAutoTextUpload);
    const liveAutoText = liveAutoUpload?.item?.file?.text
        ? await liveAutoUpload.item.file.text().catch(error => {
            warn("Failed reading live auto message.txt upload text", error);
            return null;
        })
        : null;

    if (liveAutoText && liveAutoText.length > MAX_MESSAGE_LENGTH) {
        return { content: liveAutoText, fromAutoTextUpload: true };
    }

    return { content: msg.content, fromAutoTextUpload: false };
}

function clearComposerState(channelId: string) {
    DraftManager?.clearDraft?.(channelId, DraftType.ChannelMessage);
    UploadManager?.clearAll?.(channelId, DraftType.ChannelMessage);
    FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
}

async function sendChunks(channelId: string, chunks: string[]) {
    for (const content of chunks) {
        const msg: MessageObject = {
            content,
            tts: false,
            invalidEmojis: [],
            validNonShortcutEmojis: []
        };

        try {
            await Promise.resolve(MessageActions._sendMessage(channelId, msg, {} as MessageOptions));
        } catch (error) {
            warn("Failed sending split follow-up chunk", error);
        }
    }
}

async function sendFollowUpChunks(
    channelId: string,
    baseMessage: MessageObject,
    options: MessageOptions,
    chunks: string[]
) {
    for (const chunk of chunks) {
        try {
            await Promise.resolve(MessageActions._sendMessage(channelId, {
                ...baseMessage,
                content: chunk
            }, options));
        } catch (error) {
            warn("Failed sending scheduled split chunk", error);
        }
    }
}

export default definePlugin({
    name: "SplitLongMessages",
    description: "Splits messages longer than 2000 characters into multiple messages while preserving paragraph spacing.",
    authors: [Devs.marcmy],
    settings,

    async onBeforeMessageSend(channelId: string, msg: MessageObject, options: MessageOptions | undefined) {
        if (!msg.content && !options?.uploads?.length) return;
        if ((msg as Record<string, unknown>)[HANDLED_FLAG]) return;

        const { content, fromAutoTextUpload } = await resolveLongMessageContent(channelId, msg, options);
        if (content.length <= MAX_MESSAGE_LENGTH) return;

        const mode = (settings.store.leadingBlankLineMode ?? "trim") as LeadingBlankLineMode;
        const chunks = splitContent(content, MAX_MESSAGE_LENGTH, mode);
        if (chunks.length <= 1) return;

        if (fromAutoTextUpload) {
            clearComposerState(channelId);
            void sendChunks(channelId, chunks);
            return { cancel: true };
        }

        (msg as Record<string, unknown>)[HANDLED_FLAG] = true;
        msg.content = chunks.shift()!;

        if (options) options.content = msg.content;
        stripAutoTextUploads(options);

        const followUpOptions = buildFollowUpOptions(options) ?? {} as MessageOptions;
        setTimeout(() => {
            void sendFollowUpChunks(channelId, msg, followUpOptions, chunks);
        }, 0);
    }
});
