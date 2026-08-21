/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, DraftType, Forms, Modal, openModal, React, SelectedChannelStore, UploadHandler, useState } from "@webpack/common";

import basePlugin from "./impl";

const MAX_MESSAGE_LENGTH = 2000;
const LEADING_GUARD = "\u200b";
const LEADING_BLANK_LINE_GUARD = "\u2800";
const VISIBLE_BLANK_LINE_MARKER = "·";
const TEXT_NODE = 3;

const ChannelTextAreaClasses = findByPropsLazy("channelTextArea");

type PromptToUpload = (files: File[], channel: any, draftType: number) => any;

type PasteLargeMessageModalProps = {
    modalProps: any;
    initialText: string;
    onClose(): void;
    onPasteMessages(text: string): void;
    onPasteAsFile(text: string): void;
};

let activePlugin: any = null;
let nativePromptToUpload: PromptToUpload | null = null;
let pasteHandler: ((event: ClipboardEvent) => void) | null = null;
const pasteModalChannels = new Set<string>();

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

function getTargetElement(target: EventTarget | null) {
    if (!target) return null;
    if (target instanceof HTMLElement) return target;

    const node = target as Node;
    if (node.nodeType === TEXT_NODE) return node.parentElement;
    return null;
}

function isChatInputTarget(target: EventTarget | null) {
    const el = getTargetElement(target) ?? (document.activeElement as HTMLElement | null);
    if (!el) return false;

    const channelClass = safeGet(() => ChannelTextAreaClasses?.channelTextArea);
    if (channelClass && el.closest?.(`.${channelClass}`)) return true;

    if (el.isContentEditable && el.getAttribute?.("role") === "textbox") return true;
    return el instanceof HTMLTextAreaElement;
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
            // Defensive fallback for an unexpected edge case. The base plugin
            // has the same 2,000-character hard-slice fallback when sending.
            dropLength = Math.max(1, sliceLimit);
        }

        count++;
        remaining = remaining.slice(dropLength);
    }

    return count;
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
                    "message.txt",
                    { type: "text/plain" }
                );
                nativePromptToUpload([file], channel, DraftType.ChannelMessage);
            }
        });
    });

    return true;
}

const originalStart = (basePlugin as any).start;
const originalStop = (basePlugin as any).stop;

export default definePlugin({
    ...(basePlugin as any),
    name: "SplitLargeMessages",
    description: "Splits large messages and lets long pastes be sent as multiple messages or Discord's native text-file upload.",
    authors: [Devs.marcmy],
    dependencies: ["MessageEventsAPI"],
    patches: (basePlugin as any).patches,

    start() {
        activePlugin = this;

        const promptToUpload = safeGet(() => UploadHandler?.promptToUpload);
        nativePromptToUpload = typeof promptToUpload === "function"
            ? promptToUpload.bind(UploadHandler)
            : null;

        originalStart?.call(this);

        pasteHandler = event => {
            if (event.defaultPrevented) return;
            if (!isChatInputTarget(event.target)) return;
            if (event.clipboardData?.files?.length) return;

            const text = event.clipboardData?.getData("text/plain") ?? "";
            if (normalizeLineEndings(text).length <= MAX_MESSAGE_LENGTH) return;

            const channelId = SelectedChannelStore.getChannelId();
            if (!channelId || !openPasteChoice(channelId, text)) return;

            event.preventDefault();
            event.stopImmediatePropagation();
        };

        document.addEventListener("paste", pasteHandler, true);
    },

    stop() {
        if (pasteHandler) {
            document.removeEventListener("paste", pasteHandler, true);
            pasteHandler = null;
        }

        pasteModalChannels.clear();
        nativePromptToUpload = null;

        try {
            originalStop?.call(this);
        } finally {
            activePlugin = null;
        }
    }
});
