/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelStore, DraftType, Forms, Modal, openModal, React, SelectedChannelStore, UploadAttachmentStore, UploadHandler, UploadManager, useState } from "@webpack/common";

import basePlugin from "./impl";

const MAX_MESSAGE_LENGTH = 2000;
const LEADING_GUARD = "\u200b";
const LEADING_BLANK_LINE_GUARD = "\u2800";
const VISIBLE_BLANK_LINE_MARKER = "·";
const AUTO_TEXT_FILENAME = "message.txt";
const NATIVE_FILE_GRACE_MS = 5000;

type PromptToUpload = (files: File[], channel: any, draftType: number) => any;

type PasteLargeMessageModalProps = {
    modalProps: any;
    initialText: string;
    onClose(): void;
    onPasteMessages(text: string): void;
    onPasteAsFile(text: string): void;
};

type NativeFileState = {
    expiresAt: number;
    seen: boolean;
};

let activePlugin: any = null;
let nativePromptToUpload: PromptToUpload | null = null;
const pasteModalChannels = new Set<string>();
const nativeFileStates = new Map<string, NativeFileState>();

function safeGet<T>(getter: () => T): T | undefined {
    try {
        return getter();
    } catch {
        return void 0;
    }
}

function normalizeLineEndings(text: string) {
    return text.replace(/\r\n?/g, "\n");
}

function getLeadingBlankLineMode() {
    return activePlugin?.settings?.store?.leadingBlankLineMode
        ?? (basePlugin as any).settings?.store?.leadingBlankLineMode
        ?? "trim";
}

function findSplitIndex(text: string) {
    const doubleNewline = text.lastIndexOf("\n\n");
    if (doubleNewline > -1) return { index: doubleNewline, separatorKind: "double_newline" as const };

    const singleNewline = text.lastIndexOf("\n");
    if (singleNewline > -1) return { index: singleNewline, separatorKind: "single_newline" as const };

    const space = text.lastIndexOf(" ");
    if (space > -1) return { index: space, separatorKind: "space" as const };

    return { index: text.length, separatorKind: "none" as const };
}

function getLeadingGuardExtra(text: string) {
    let extra = 0;
    const leadingNewlines = text.match(/^\n+/)?.[0].length ?? 0;
    const needsPrefixIndentGuard = leadingNewlines === 0 && /^[\t ]/.test(text);
    const needsIndentGuardAfterNewlines = leadingNewlines > 0 && /^[\n]+[\t ]/.test(text);
    const leadingBlankLineMode = getLeadingBlankLineMode();

    const leadingBlankLinePrefix =
        leadingBlankLineMode === "invisible" ? LEADING_BLANK_LINE_GUARD
            : leadingBlankLineMode === "visible_marker" ? VISIBLE_BLANK_LINE_MARKER
                : "";

    if (leadingBlankLinePrefix) extra += leadingNewlines * leadingBlankLinePrefix.length;
    if (needsPrefixIndentGuard) extra += LEADING_GUARD.length;
    if (needsIndentGuardAfterNewlines) extra += LEADING_GUARD.length;
    return extra;
}

function getSafeSliceLimit(text: string, limit: number) {
    const slice = text.slice(0, limit);
    const tokenStart = slice.lastIndexOf("<");
    if (tokenStart <= slice.lastIndexOf(">")) return limit;

    return /^<a?:[^:\s]+:\d+>/.test(text.slice(tokenStart)) ? tokenStart : limit;
}

function countMessageChunks(content: string, maxLen = MAX_MESSAGE_LENGTH) {
    let remaining = normalizeLineEndings(content);
    let count = 0;
    const preserveLeadingBlankLines = getLeadingBlankLineMode() !== "trim";

    while (remaining.length > 0) {
        const limit = maxLen - getLeadingGuardExtra(remaining);
        if (remaining.length <= limit) {
            count++;
            break;
        }

        const sliceLimit = getSafeSliceLimit(remaining, limit);
        const slice = remaining.slice(0, sliceLimit);
        const { index, separatorKind } = findSplitIndex(slice);
        let splitAt = index;
        let takeLength = splitAt;
        let dropLength = splitAt;

        if (splitAt <= 0) {
            splitAt = sliceLimit;
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

        if (takeLength <= 0 || dropLength <= 0) {
            dropLength = Math.max(1, sliceLimit);
        }

        count++;
        remaining = remaining.slice(dropLength);
    }

    return count;
}

function getUploadFilename(upload: any) {
    return upload?.filename ?? upload?.item?.file?.name ?? "";
}

function hasNativeTextFileUpload(channelId: string) {
    const uploads = safeGet(() => UploadAttachmentStore?.getUploads?.(channelId, DraftType.ChannelMessage)) ?? [];
    return uploads.some(upload => getUploadFilename(upload) === AUTO_TEXT_FILENAME);
}

function markNativeFilePending(channelId: string) {
    nativeFileStates.set(channelId, {
        expiresAt: Date.now() + NATIVE_FILE_GRACE_MS,
        seen: false
    });
}

function isNativeFileActive(channelId: string) {
    const state = nativeFileStates.get(channelId);
    if (!state) return false;

    if (hasNativeTextFileUpload(channelId)) {
        state.seen = true;
        return true;
    }

    if (state.seen || Date.now() >= state.expiresAt) {
        nativeFileStates.delete(channelId);
        return false;
    }

    return true;
}

function optionsContainNativeTextFile(options: any) {
    return !!options?.uploads?.some((upload: any) => getUploadFilename(upload) === AUTO_TEXT_FILENAME);
}

function guardComposerHandler(plugin: any, property: "keydownHandler" | "clickHandler" | "submitHandler", eventName: "keydown" | "click" | "submit") {
    const original = plugin[property];
    if (typeof original !== "function") return;

    document.removeEventListener(eventName, original, true);

    const guarded = (event: Event) => {
        const channelId = SelectedChannelStore.getChannelId();
        if (channelId && isNativeFileActive(channelId)) return;
        original(event);
    };

    plugin[property] = guarded;
    document.addEventListener(eventName, guarded, true);
}

function PasteLargeMessageModal({
    modalProps,
    initialText,
    onClose,
    onPasteMessages,
    onPasteAsFile
}: PasteLargeMessageModalProps) {
    const [text, setText] = useState(initialText);
    const chunkCount = countMessageChunks(text);
    const trimmedLength = text.trim().length;

    const pasteMessagesLabel = chunkCount > 1
        ? `Paste ${chunkCount.toLocaleString()} Messages`
        : "Paste Message";

    return React.createElement(
        Modal,
        {
            ...modalProps,
            onClose,
            title: "Paste Large Message",
            size: "lg",
            actions: [
                {
                    text: pasteMessagesLabel,
                    variant: "primary",
                    disabled: trimmedLength === 0,
                    onClick: () => {
                        onClose();
                        onPasteMessages(text);
                    }
                },
                {
                    text: "Paste as File",
                    variant: "secondary",
                    disabled: trimmedLength === 0,
                    onClick: () => {
                        onClose();
                        onPasteAsFile(text);
                    }
                },
                {
                    text: "Cancel",
                    variant: "secondary",
                    onClick: onClose
                }
            ]
        },
        React.createElement(
            Forms.FormText,
            { style: { marginBottom: 8 } },
            `${text.length.toLocaleString()} characters · ${chunkCount.toLocaleString()} message${chunkCount === 1 ? "" : "s"}`
        ),
        React.createElement("textarea", {
            value: text,
            onChange: (event: Event) => setText((event.target as HTMLTextAreaElement).value),
            spellCheck: true,
            style: {
                width: "100%",
                minHeight: 420,
                resize: "vertical",
                boxSizing: "border-box",
                color: "var(--text-normal)",
                background: "var(--input-background)",
                border: "1px solid var(--input-border)",
                borderRadius: 4,
                padding: 10,
                fontFamily: "var(--font-primary)",
                fontSize: 14,
                lineHeight: "20px"
            }
        })
    );
}

function openPasteChoice(channelId: string, rawText: string) {
    const content = normalizeLineEndings(rawText);
    if (!content || content.length <= MAX_MESSAGE_LENGTH) return false;
    if (pasteModalChannels.has(channelId)) return true;

    const channel = safeGet(() => ChannelStore.getChannel(channelId));
    if (!channel) return false;

    pasteModalChannels.add(channelId);

    openModal(modalProps => {
        const close = () => {
            pasteModalChannels.delete(channelId);
            modalProps.onClose?.();
        };

        return React.createElement(PasteLargeMessageModal, {
            modalProps,
            initialText: content,
            onClose: close,
            onPasteMessages: (editedText: string) => {
                activePlugin?.sendSplitFromDraft(channelId, editedText);
            },
            onPasteAsFile: (editedText: string) => {
                if (!nativePromptToUpload) return;

                const file = new File(
                    [normalizeLineEndings(editedText)],
                    AUTO_TEXT_FILENAME,
                    { type: "text/plain" }
                );

                markNativeFilePending(channelId);
                try {
                    nativePromptToUpload([file], channel, DraftType.ChannelMessage);
                } catch (error) {
                    nativeFileStates.delete(channelId);
                    throw error;
                }
            }
        });
    });

    return true;
}

const originalStart = (basePlugin as any).start;
const originalStop = (basePlugin as any).stop;
const originalPolishComposerUi = (basePlugin as any).polishComposerUi;
const originalOnBeforeMessageSend = (basePlugin as any).onBeforeMessageSend;

export default definePlugin({
    ...(basePlugin as any),
    name: "SplitLargeMessages",
    description: "Splits large messages and lets long pastes be sent as multiple messages or Discord's native text-file upload.",
    authors: [Devs.marcmy],
    dependencies: ["MessageEventsAPI"],
    patches: (basePlugin as any).patches,

    openLongMessageEditor(channelId: string, text: string) {
        const content = normalizeLineEndings(text);
        if (!content || content.length <= MAX_MESSAGE_LENGTH) return false;

        // Discord may already have materialized the large paste as message.txt.
        // Remove that transient upload before opening our choice modal; otherwise
        // the base plugin's UI poller sees it after close and reopens forever.
        safeGet(() => UploadManager?.clearAll?.(channelId, DraftType.ChannelMessage));
        this.restoreUiNodes?.();

        return openPasteChoice(channelId, content);
    },

    polishComposerUi() {
        const channelId = SelectedChannelStore.getChannelId();
        if (channelId && isNativeFileActive(channelId)) {
            // The user explicitly chose Discord's file-send path. Do not let the
            // inherited auto-message.txt cleanup hide it or reopen the modal.
            this.restoreUiNodes?.();
            return;
        }

        return originalPolishComposerUi?.call(this);
    },

    async onBeforeMessageSend(channelId: string, msg: any, options: any, props: any) {
        const state = nativeFileStates.get(channelId);
        if (state) {
            const hasFile = optionsContainNativeTextFile(options) || hasNativeTextFileUpload(channelId);
            if (hasFile) {
                nativeFileStates.delete(channelId);
                return;
            }

            if (state.seen || Date.now() >= state.expiresAt) {
                nativeFileStates.delete(channelId);
            }
        }

        return originalOnBeforeMessageSend?.call(this, channelId, msg, options, props);
    },

    start() {
        activePlugin = this;

        // Capture Discord's original implementation before the inherited plugin
        // wraps promptToUpload. This is the escape hatch for "Paste as File".
        const promptToUpload = safeGet(() => UploadHandler?.promptToUpload);
        nativePromptToUpload = typeof promptToUpload === "function"
            ? promptToUpload.bind(UploadHandler)
            : null;

        originalStart?.call(this);

        // The inherited handlers normally hijack Enter/click/submit whenever a
        // message.txt upload exists. Guard them only while the user has explicitly
        // chosen the native file path, so Discord can send the file normally.
        guardComposerHandler(this, "keydownHandler", "keydown");
        guardComposerHandler(this, "clickHandler", "click");
        guardComposerHandler(this, "submitHandler", "submit");
    },

    stop() {
        pasteModalChannels.clear();
        nativeFileStates.clear();
        nativePromptToUpload = null;

        try {
            originalStop?.call(this);
        } finally {
            activePlugin = null;
        }
    }
});
