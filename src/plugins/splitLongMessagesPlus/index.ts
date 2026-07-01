/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageObject, MessageOptions } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { filters, findAll, findByPropsLazy, moduleListeners } from "@webpack";
import { DraftStore, DraftType, FluxDispatcher, Forms, MessageActions, Modal, openModal, React, SelectedChannelStore, UploadAttachmentStore, UploadHandler, UploadManager, useState } from "@webpack/common";

const MAX_MESSAGE_LENGTH = 2000;
const LEADING_GUARD = "\u200b";
// Discord may trim leading empty lines even if guarded by zero-width chars.
// Braille blank is visually empty but tends to survive trimming.
const LEADING_BLANK_LINE_GUARD = "\u2800";
const VISIBLE_BLANK_LINE_MARKER = "·";
const LIMIT_OVERRIDE = 2 ** 30;
const HANDLED_FLAG = "__vencordSplitLongMessagesHandled";
const WRAPPED_WARNING = Symbol("splitLongMessages.wrappedWarning");
const WRAPPED_UPLOAD = Symbol("splitLongMessages.wrappedUpload");
const NITRO_UPSELL_TEXT = "Send longer messages with Discord Nitro!";

const DraftManager = findByPropsLazy("clearDraft", "saveDraft");
const WarningPopout = findByPropsLazy("openWarningPopout");
const ChannelTextAreaClasses = findByPropsLazy("channelTextArea");
const TEXT_NODE = 3;

const settings = definePluginSettings({
    leadingBlankLineMode: {
        type: OptionType.SELECT,
        description: "How to handle blank lines at the start of split chunks",
        options: [
            { label: "Trim", value: "trim", default: true },
            { label: "Invisible guard (best effort)", value: "invisible" },
            { label: "Visible marker (exact spacing)", value: "visible_marker" },
        ]
    }
});

function patchMessageLengthConstantsInObject(mod: any, updated: Array<{ mod: Record<string, any>; key: string; value: number }>, seen: Set<Record<string, any>>) {
    if (!mod || typeof mod !== "object") return;
    if (seen.has(mod)) return;
    seen.add(mod);

    for (const [key, value] of Object.entries(mod)) {
        if (!key.includes("MAX_MESSAGE_LENGTH") || typeof value !== "number") continue;
        if (value === LIMIT_OVERRIDE) continue;

        try {
            mod[key] = LIMIT_OVERRIDE;
            updated.push({ mod, key, value });
        } catch { }
    }
}

function safeGet<T>(getter: () => T): T | undefined {
    try {
        return getter();
    } catch {
        return void 0;
    }
}

function patchWarningTarget(plugin: any, target: Record<string, any>) {
    if (!target || typeof target !== "object") return;
    if ((target as any)[WRAPPED_WARNING]) return;
    if (typeof target.openWarningPopout !== "function") return;

    const original = target.openWarningPopout.bind(target);
    plugin.originalOpenWarningPopouts.push({ obj: target, fn: original });
    target.openWarningPopout = (props: any) => plugin.handleTooLongWarning(props, original);
    (target as any)[WRAPPED_WARNING] = true;
}

function patchUploadTarget(plugin: any, target: Record<string, any>) {
    if (!target || typeof target !== "object") return;
    if ((target as any)[WRAPPED_UPLOAD]) return;
    if (typeof target.promptToUpload !== "function") return;

    const original = target.promptToUpload.bind(target);
    plugin.originalPromptToUploads.push({ obj: target, fn: original });
    target.promptToUpload = (files: File[], channel: any, draftType: number) => {
        const file = files?.[0];
        const channelId = channel?.id ?? SelectedChannelStore.getChannelId();
        if (!channelId || draftType !== DraftType.ChannelMessage || !isAutoTextFile(file)) {
            return original(files, channel, draftType);
        }

        if (file?.text) {
            void file.text().then((text: string) => {
                const content = normalizeLineEndings(text);
                if (content.length > MAX_MESSAGE_LENGTH && plugin.openLongMessageEditor(channelId, content)) return;
                original(files, channel, draftType);
            }).catch(() => original(files, channel, draftType));
            return;
        }

        const draft = DraftStore.getDraft(channelId, DraftType.ChannelMessage) ?? "";
        if (draft.length > MAX_MESSAGE_LENGTH) {
            plugin.openLongMessageEditor(channelId, draft);
            return;
        }

        return original(files, channel, draftType);
    };
    (target as any)[WRAPPED_UPLOAD] = true;
}

function getTargetElement(target: EventTarget | null) {
    if (!target) return null;
    if (target instanceof HTMLElement) return target;
    const node = target as Node;
    if (node.nodeType === TEXT_NODE) return node.parentElement;
    return null;
}

function normalizeLineEndings(text: string) {
    return text.replace(/\r\n?/g, "\n");
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

function getLeadingGuardInfo(text: string) {
    let extra = 0;
    const leadingNewlines = text.match(/^\n+/)?.[0].length ?? 0;
    const needsPrefixIndentGuard = leadingNewlines === 0 && /^[\t ]/.test(text);
    const needsIndentGuardAfterNewlines = leadingNewlines > 0 && /^[\n]+[\t ]/.test(text);
    const leadingBlankLineMode = settings.store.leadingBlankLineMode ?? "trim";

    const leadingBlankLinePrefix =
        leadingBlankLineMode === "invisible" ? LEADING_BLANK_LINE_GUARD
            : leadingBlankLineMode === "visible_marker" ? VISIBLE_BLANK_LINE_MARKER
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

function splitContent(content: string, maxLen = MAX_MESSAGE_LENGTH) {
    const chunks: string[] = [];
    let remaining = content;
    const leadingBlankLineMode = settings.store.leadingBlankLineMode ?? "trim";
    const preserveLeadingBlankLines = leadingBlankLineMode !== "trim";

    while (remaining.length > 0) {
        const guardInfo = getLeadingGuardInfo(remaining);
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
                // Keep the separator on the next chunk so the selected mode
                // can inject an invisible/visible guard line.
                dropLength = splitAt;
            } else {
                // Trim mode: attach newline to previous chunk to avoid
                // Discord trimming/normalizing leading blank lines.
                takeLength = Math.min(splitAt + 1, slice.length);
                dropLength = takeLength;
            }
        } else if (separatorKind === "double_newline") {
            if (preserveLeadingBlankLines) {
                // Keep paragraph break on next chunk so guards/markers apply.
                dropLength = splitAt;
            } else {
                // Trim mode keeps separators with previous chunk.
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
    if (!options) return options;

    return {
        ...options,
        uploads: undefined,
        stickers: undefined,
        replyOptions: options.replyOptions
            ? { messageReference: null, allowedMentions: options.replyOptions.allowedMentions }
            : options.replyOptions
    } satisfies MessageOptions;
}

function getLongMessageContentSync(channelId: string, msg: MessageObject) {
    if (msg.content.length > MAX_MESSAGE_LENGTH) return msg.content;

    const draft = DraftStore.getDraft(channelId, DraftType.ChannelMessage);
    if (draft?.length > MAX_MESSAGE_LENGTH) return draft;

    return msg.content;
}

function isAutoTextUpload(upload: any) {
    if (upload?.showLargeMessageDialog) return true;

    const filename = upload?.filename ?? upload?.item?.file?.name;
    if (filename !== "message.txt") return false;

    const mimeType = upload?.mimeType ?? upload?.item?.file?.type;
    return !mimeType || mimeType === "text/plain";
}

function isAutoTextFile(file: File | undefined) {
    if (!file) return false;
    if (file.name !== "message.txt") return false;
    return !file.type || file.type === "text/plain";
}

async function getLongMessageContent(channelId: string, msg: MessageObject, options: MessageOptions | undefined) {
    if (msg.content.length > MAX_MESSAGE_LENGTH) return msg.content;

    const draft = DraftStore.getDraft(channelId, DraftType.ChannelMessage);
    if (draft?.length > MAX_MESSAGE_LENGTH) return draft;

    const optionUploadText = await readAutoTextUpload(options?.uploads?.find(isAutoTextUpload));
    if (optionUploadText) return optionUploadText;

    const liveUploadText = await readAutoTextUpload(getLiveAutoTextUpload(channelId));
    if (liveUploadText) return liveUploadText;

    return msg.content;
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

function getLiveAutoTextUpload(channelId: string) {
    const uploads = safeGet(() => UploadAttachmentStore?.getUploads?.(channelId, DraftType.ChannelMessage)) ?? [];
    return uploads.find(isAutoTextUpload);
}

function hasLiveAutoTextUpload(channelId: string) {
    return !!getLiveAutoTextUpload(channelId);
}

async function readAutoTextUpload(upload: any) {
    const file = upload?.item?.file;
    if (!file?.text) return "";

    try {
        const text = normalizeLineEndings(await file.text());
        return text.length > MAX_MESSAGE_LENGTH ? text : "";
    } catch {
        return "";
    }
}

function sendFollowUps(channelId: string, baseMessage: MessageObject, options: MessageOptions | undefined, chunks: string[]) {
    if (chunks.length === 0) return;
    const followUpOptions = buildFollowUpOptions(options) ?? {} as any;

    for (const chunk of chunks) {
        MessageActions._sendMessage(channelId, {
            ...baseMessage,
            content: chunk
        }, followUpOptions);
    }
}

function clearComposerState(channelId: string) {
    DraftManager?.clearDraft?.(channelId, DraftType.ChannelMessage);
    UploadManager?.clearAll?.(channelId, DraftType.ChannelMessage);
    FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
}

async function sendChunksSequentially(channelId: string, chunks: string[]) {
    for (const content of chunks) {
        const msg: MessageObject = {
            content,
            tts: false,
            invalidEmojis: [],
            validNonShortcutEmojis: []
        };

        try {
            if (MessageActions.sendMessage) {
                await Promise.resolve(MessageActions.sendMessage(channelId, msg, true, {} as any));
            } else {
                await Promise.resolve(MessageActions._sendMessage(channelId, msg, {} as any));
            }
        } catch {
            // Keep best-effort behavior; continue attempting later chunks.
        }
    }
}

function isChatInputTarget(target: EventTarget | null) {
    const el = getTargetElement(target) ?? (document.activeElement as HTMLElement | null);
    if (!el) return false;

    const channelClass = safeGet(() => ChannelTextAreaClasses?.channelTextArea);
    if (channelClass && el.closest?.(`.${channelClass}`)) return true;

    if (el.isContentEditable && el.getAttribute?.("role") === "textbox") return true;
    return el instanceof HTMLTextAreaElement;
}

function getDraftContent(channelId: string, target?: EventTarget | null) {
    let content = DraftStore.getDraft(channelId, DraftType.ChannelMessage) ?? "";
    if (content.length > MAX_MESSAGE_LENGTH) return content;

    const el = getTargetElement(target ?? null) ?? (document.activeElement as HTMLElement | null);
    if (el?.isContentEditable) {
        const text = el.innerText ?? el.textContent ?? "";
        if (text.length > content.length) content = text;
    }

    return content;
}

function LongMessageEditorModal({
    modalProps,
    initialText,
    onClose,
    onSend
}: {
    modalProps: any;
    initialText: string;
    onClose(): void;
    onSend(text: string): void;
}) {
    const [text, setText] = useState(initialText);
    const chunkCount = splitContent(text, MAX_MESSAGE_LENGTH).filter(Boolean).length;
    const trimmedLength = text.trim().length;

    return React.createElement(
        Modal,
        {
            ...modalProps,
            onClose,
            title: "Edit Long Message",
            size: "lg",
            actions: [
                {
                    text: chunkCount > 1 ? `Send ${chunkCount} Messages` : "Send Message",
                    variant: "primary",
                    disabled: trimmedLength === 0,
                    onClick: () => {
                        onSend(text);
                        onClose();
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
            `${text.length.toLocaleString()} characters, ${chunkCount.toLocaleString()} message${chunkCount === 1 ? "" : "s"}`
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

export default definePlugin({
    name: "SplitLongMessagesPlus",
    description: "Splits long messages and includes local UI polish for Discord's long-message composer flow.",
    authors: [Devs.marcmy],
    settings,

    patches: [
        {
            find: ".handleSendMessage,onResize:",
            replacement: {
                match: /let (\i)=\i\.\i\.parse\((\i),.+?\.getSendMessageOptions\(\{.+?\}\)?;(?=.+?(\i)\.flags=)(?<=\)\((\{.+?})\)\.then.+?)/,
                replace: (m, parsedMessage, channel, replyOptions, extra) =>
                    `${m}$self.handleEarlySplit(${channel}.id,${parsedMessage},${extra},${replyOptions});`
            }
        }
    ],

    originalMessageLimits: null as null | Array<{ mod: Record<string, any>; key: string; value: number }>,
    originalOpenWarningPopouts: [] as Array<{ obj: Record<string, any>; fn: (props: any) => any }>,
    originalSendMessage: null as null | ((channelId: string, msg: MessageObject, waitForChannelReady?: boolean, options?: any) => any),
    originalPromptToUploads: [] as Array<{ obj: Record<string, any>; fn: (files: File[], channel: any, draftType: number) => any }>,
    sendingSplit: false,
    openingEditorChannels: new Set<string>(),
    editorModalChannels: new Set<string>(),
    moduleListener: null as null | ((exports: any) => void),
    uiObserver: null as null | MutationObserver,
    uiPollInterval: null as null | number,
    keydownHandler: null as null | ((event: KeyboardEvent) => void),
    clickHandler: null as null | ((event: MouseEvent) => void),
    submitHandler: null as null | ((event: Event) => void),

    start() {
        const updated: Array<{ mod: Record<string, any>; key: string; value: number }> = [];
        const seen = new Set<Record<string, any>>();
        for (const mod of findAll(filters.byProps("MAX_MESSAGE_LENGTH"))) {
            patchMessageLengthConstantsInObject(mod, updated, seen);
        }

        this.moduleListener = (exports: any) => {
            patchMessageLengthConstantsInObject(exports, updated, seen);
            patchWarningTarget(this, exports);
            patchUploadTarget(this, exports);
            if (!exports || typeof exports !== "object") return;
            for (const value of Object.values(exports)) {
                patchMessageLengthConstantsInObject(value, updated, seen);
                patchWarningTarget(this, value as any);
                patchUploadTarget(this, value as any);
            }
        };
        moduleListeners.add(this.moduleListener);

        this.originalMessageLimits = updated;

        const warningTargets = new Set<Record<string, any>>();
        const warningPopoutModule = safeGet(() => WarningPopout as any);
        if (warningPopoutModule && safeGet(() => typeof warningPopoutModule.openWarningPopout === "function")) {
            warningTargets.add(warningPopoutModule);
        }
        for (const mod of findAll(filters.byProps("openWarningPopout"))) {
            if (mod && typeof mod === "object") warningTargets.add(mod as any);
        }
        for (const target of warningTargets) {
            patchWarningTarget(this, target);
        }

        if (MessageActions?.sendMessage) {
            this.originalSendMessage = MessageActions.sendMessage.bind(MessageActions);
            MessageActions.sendMessage = (channelId, msg, waitForChannelReady, options) => {
                if (msg?.content?.length > MAX_MESSAGE_LENGTH) {
                    const chunks = splitContent(msg.content, MAX_MESSAGE_LENGTH);
                    if (chunks.length > 1) {
                        msg.content = chunks.shift()!;
                        setTimeout(() => {
                            sendFollowUps(channelId, msg, options, chunks);
                        }, 0);
                    }
                }

                return this.originalSendMessage!(channelId, msg, waitForChannelReady, options);
            };
        }

        const uploadTargets = new Set<Record<string, any>>();
        const uploadHandlerModule = safeGet(() => UploadHandler as any);
        if (uploadHandlerModule && safeGet(() => typeof uploadHandlerModule.promptToUpload === "function")) {
            uploadTargets.add(uploadHandlerModule);
        }
        for (const mod of findAll(filters.byProps("promptToUpload"))) {
            if (mod && typeof mod === "object") uploadTargets.add(mod as any);
        }
        for (const target of uploadTargets) {
            patchUploadTarget(this, target);
        }

        this.keydownHandler = event => {
            if (event.key !== "Enter" || event.shiftKey) return;
            if (!isChatInputTarget(event.target)) return;

            const channelId = SelectedChannelStore.getChannelId();
            if (!channelId) return;
            const content = getDraftContent(channelId, event.target);
            if (!content || content.length <= MAX_MESSAGE_LENGTH) {
                if (!hasLiveAutoTextUpload(channelId)) return;

                event.preventDefault();
                event.stopImmediatePropagation();
                void this.openEditorFromLiveAutoUpload(channelId);
                return;
            }

            event.preventDefault();
            event.stopImmediatePropagation();

            this.sendSplitFromDraft(channelId, content);
        };

        this.clickHandler = event => {
            const target = event.target as HTMLElement | null;
            if (!target?.closest?.("#submit-button")) return;

            const channelId = SelectedChannelStore.getChannelId();
            if (!channelId) return;
            const content = getDraftContent(channelId, document.activeElement);
            if (!content || content.length <= MAX_MESSAGE_LENGTH) {
                if (!hasLiveAutoTextUpload(channelId)) return;

                event.preventDefault();
                event.stopImmediatePropagation();
                void this.openEditorFromLiveAutoUpload(channelId);
                return;
            }

            event.preventDefault();
            event.stopImmediatePropagation();

            this.sendSplitFromDraft(channelId, content);
        };

        this.submitHandler = event => {
            const target = event.target as HTMLElement | null;
            if (!target) return;

            const channelClass = safeGet(() => ChannelTextAreaClasses?.channelTextArea);
            if (channelClass && !target.querySelector?.(`.${channelClass}`)) return;

            const channelId = SelectedChannelStore.getChannelId();
            if (!channelId) return;
            const content = getDraftContent(channelId, document.activeElement);
            if (!content || content.length <= MAX_MESSAGE_LENGTH) {
                if (!hasLiveAutoTextUpload(channelId)) return;

                event.preventDefault();
                event.stopImmediatePropagation();
                void this.openEditorFromLiveAutoUpload(channelId);
                return;
            }

            event.preventDefault();
            event.stopImmediatePropagation();

            this.sendSplitFromDraft(channelId, content);
        };

        document.addEventListener("keydown", this.keydownHandler, true);
        document.addEventListener("click", this.clickHandler, true);
        document.addEventListener("submit", this.submitHandler, true);

        this.startUiPolish();
    },

    stop() {
        this.stopUiPolish();

        if (this.moduleListener) {
            moduleListeners.delete(this.moduleListener);
            this.moduleListener = null;
        }

        if (this.keydownHandler) {
            document.removeEventListener("keydown", this.keydownHandler, true);
            this.keydownHandler = null;
        }
        if (this.clickHandler) {
            document.removeEventListener("click", this.clickHandler, true);
            this.clickHandler = null;
        }
        if (this.submitHandler) {
            document.removeEventListener("submit", this.submitHandler, true);
            this.submitHandler = null;
        }

        if (this.originalSendMessage && safeGet(() => MessageActions?.sendMessage)) {
            MessageActions.sendMessage = this.originalSendMessage;
            this.originalSendMessage = null;
        }

        if (this.originalPromptToUploads.length) {
            for (const { obj, fn } of this.originalPromptToUploads) {
                if (obj?.promptToUpload) obj.promptToUpload = fn;
                try { delete (obj as any)[WRAPPED_UPLOAD]; } catch { }
            }
            this.originalPromptToUploads = [];
        }
        this.openingEditorChannels.clear();
        this.editorModalChannels.clear();

        if (this.originalOpenWarningPopouts.length) {
            for (const { obj, fn } of this.originalOpenWarningPopouts) {
                if (obj?.openWarningPopout) obj.openWarningPopout = fn;
                try { delete (obj as any)[WRAPPED_WARNING]; } catch { }
            }
            this.originalOpenWarningPopouts = [];
        }

        if (!this.originalMessageLimits?.length) {
            this.originalMessageLimits = null;
            return;
        }

        for (const entry of this.originalMessageLimits) {
            try {
                entry.mod[entry.key] = entry.value;
            } catch { }
        }
        this.originalMessageLimits = null;
    },

    hideUiNode(node: HTMLElement | null | undefined) {
        if (!node) return;
        if ((node as any).dataset?.slmHidden === "1") return;

        node.dataset.slmHidden = "1";
        node.dataset.slmPrevDisplay = node.style.display ?? "";
        node.style.display = "none";
    },

    hideAutoUploadShells(composerRoot: HTMLElement | Document) {
        const rootEl = composerRoot instanceof Document ? composerRoot.body : composerRoot;
        if (!rootEl) return;

        for (const hidden of composerRoot.querySelectorAll<HTMLElement>("[data-slm-hidden='1']")) {
            let parent = hidden.parentElement;
            let depth = 0;

            while (parent && parent !== rootEl && depth++ < 8) {
                if (parent.querySelector("textarea,[role='textbox'],[contenteditable='true']")) break;

                const rect = parent.getBoundingClientRect();
                const text = (parent.textContent ?? "").trim();
                const nonHiddenChildren = Array.from(parent.children).filter(child => {
                    const el = child as HTMLElement;
                    if (el.dataset?.slmHidden === "1") return false;
                    return getComputedStyle(el).display !== "none";
                });

                const containsOnlyComposerRowText = /^(\+)?\s*message\b/i.test(text) || text === "+" || text === "";
                const hasHiddenDescendant = !!parent.querySelector("[data-slm-hidden='1']");

                const isLikelyUploadFrame =
                    hasHiddenDescendant &&
                    rect.width >= 140 && rect.width <= 700 &&
                    rect.height >= 80 && rect.height <= 420 &&
                    !parent.querySelector("textarea,[role='textbox'],[contenteditable='true']");

                if (isLikelyUploadFrame && (containsOnlyComposerRowText || nonHiddenChildren.length <= 1)) {
                    this.hideUiNode(parent);
                }

                parent = parent.parentElement;
            }
        }
    },

    openLongMessageEditor(channelId: string, text: string) {
        const content = normalizeLineEndings(text);
        if (!content || content.length <= MAX_MESSAGE_LENGTH) return false;
        if (this.editorModalChannels.has(channelId)) return true;

        this.editorModalChannels.add(channelId);
        clearComposerState(channelId);
        this.restoreUiNodes();

        openModal(modalProps => {
            const close = () => {
                this.editorModalChannels.delete(channelId);
                modalProps.onClose?.();
            };

            return React.createElement(LongMessageEditorModal, {
                modalProps,
                initialText: content,
                onClose: close,
                onSend: (editedText: string) => this.sendSplitFromDraft(channelId, editedText)
            });
        });

        return true;
    },

    openEditorFromLiveAutoUpload(channelId: string) {
        if (this.editorModalChannels.has(channelId)) return true;
        if (this.openingEditorChannels.has(channelId)) return true;

        const upload = getLiveAutoTextUpload(channelId);
        if (!upload) return false;

        const file = upload.item?.file;
        if (!file?.text) return false;

        this.openingEditorChannels.add(channelId);
        void file.text().then((text: string) => {
            this.openLongMessageEditor(channelId, text);
        }).catch(() => { }).finally(() => {
            this.openingEditorChannels.delete(channelId);
        });

        return true;
    },

    restoreUiNodes() {
        for (const node of document.querySelectorAll<HTMLElement>("[data-slm-hidden='1']")) {
            const prev = node.dataset.slmPrevDisplay;
            if (prev != null) node.style.display = prev;
            else node.style.removeProperty("display");
            node.removeAttribute("data-slm-hidden");
            node.removeAttribute("data-slm-prev-display");
        }
    },

    findComposerRoot() {
        const active = document.activeElement as HTMLElement | null;
        if (active) {
            const root = active.closest?.("form,[class*='channelTextArea']");
            if (root) return root as HTMLElement;
        }

        const channelClass = safeGet(() => ChannelTextAreaClasses?.channelTextArea);
        if (channelClass) {
            const el = document.querySelector(`.${channelClass}`);
            if (el) return el as HTMLElement;
        }

        return null;
    },

    polishComposerUi() {
        const channelId = SelectedChannelStore.getChannelId?.();
        if (!channelId) return;

        const composerRoot = this.findComposerRoot() ?? document;
        const draft = DraftStore.getDraft(channelId, DraftType.ChannelMessage) ?? "";
        const isLongDraft = draft.length > MAX_MESSAGE_LENGTH;

        if (isLongDraft) {
            for (const el of composerRoot.querySelectorAll<HTMLElement>("button, [role='button'], a, div, span")) {
                const text = el.textContent?.trim();
                if (!text) continue;

                if (text === NITRO_UPSELL_TEXT) {
                    this.hideUiNode(el.closest("button,[role='button'],a,div") as HTMLElement | null);
                    continue;
                }

                if (/^-\d+$/.test(text)) {
                    this.hideUiNode(el);
                }
            }
        }

        const uploads = safeGet(() => UploadAttachmentStore?.getUploads?.(channelId, DraftType.ChannelMessage)) ?? [];
        const hasAutoText = uploads.some(isAutoTextUpload);
        if (!hasAutoText) return;
        const onlyAutoText = uploads.length > 0 && uploads.every(isAutoTextUpload);

        if (onlyAutoText) {
            if (this.openEditorFromLiveAutoUpload(channelId)) {
                this.restoreUiNodes();
                return;
            }

            const draft = DraftStore.getDraft(channelId, DraftType.ChannelMessage) ?? "";
            if (!draft) {
                this.restoreUiNodes();
                return;
            }

            for (const el of composerRoot.querySelectorAll<HTMLElement>("button,[role='button']")) {
                const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
                if (!aria.includes("remove") && !aria.includes("delete")) continue;

                const card = el.closest("[class*='upload'], [class*='file'], [class*='container'], li, article, section") as HTMLElement | null;
                if (card) this.hideUiNode(card);
            }
        }

        for (const el of composerRoot.querySelectorAll<HTMLElement>("div, span")) {
            if (el.textContent?.trim() !== "message.txt") continue;
            const tile = el.closest("[class*='upload'], [class*='file'], [class*='container'], li, article, section") as HTMLElement | null;
            this.hideUiNode(tile ?? el);
        }

        if (onlyAutoText) {
            this.hideAutoUploadShells(composerRoot);
        }
    },

    startUiPolish() {
        this.stopUiPolish();
        this.restoreUiNodes();

        const run = () => {
            try {
                this.polishComposerUi();
            } catch { }
        };

        run();
        this.uiPollInterval = window.setInterval(run, 250);
        this.uiObserver = new MutationObserver(run);
        if (document.body) {
            this.uiObserver.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true
            });
        }
    },

    stopUiPolish() {
        if (this.uiObserver) {
            this.uiObserver.disconnect();
            this.uiObserver = null;
        }
        if (this.uiPollInterval != null) {
            clearInterval(this.uiPollInterval);
            this.uiPollInterval = null;
        }
        this.restoreUiNodes();
    },

    handleEarlySplit(channelId: string, msg: MessageObject, options: MessageOptions | undefined, replyOptions: MessageOptions["replyOptions"]) {
        if (!msg.content && !options?.uploads?.length) return;
        if ((msg as any)[HANDLED_FLAG]) return;

        if (options) options.replyOptions = replyOptions;

        const content = getLongMessageContentSync(channelId, msg);
        if (content.length <= MAX_MESSAGE_LENGTH) return;

        const chunks = splitContent(content, MAX_MESSAGE_LENGTH);
        if (chunks.length <= 1) return;

        (msg as any)[HANDLED_FLAG] = true;
        msg.content = chunks.shift()!;
        if (options) options.content = msg.content;
        stripAutoTextUploads(options);

        setTimeout(() => {
            sendFollowUps(channelId, msg, options, chunks);
        }, 0);
    },

    handleTooLongWarning(props: any, fallback?: (props: any) => any) {
        const channelId = props?.channel?.id ?? props?.channelId ?? SelectedChannelStore.getChannelId();
        if (!channelId) {
            return { shouldClear: false, shouldRefocus: true };
        }

        const rawContent = typeof props?.content === "string"
            ? props.content
            : typeof props?.text === "string"
                ? props.text
                : DraftStore.getDraft(channelId, DraftType.ChannelMessage);

        if (!rawContent || rawContent.length <= MAX_MESSAGE_LENGTH) {
            return fallback?.(props) ?? { shouldClear: false, shouldRefocus: true };
        }

        this.openLongMessageEditor(channelId, rawContent);

        return { shouldClear: false, shouldRefocus: true };
    },

    sendSplitFromDraft(channelId: string, content: string) {
        if (this.sendingSplit) return;
        this.sendingSplit = true;

        try {
            const chunks = splitContent(content, MAX_MESSAGE_LENGTH);
            if (chunks.length === 0) return;
            void sendChunksSequentially(channelId, chunks);

            clearComposerState(channelId);
        } finally {
            this.sendingSplit = false;
        }
    },

    async onBeforeMessageSend(channelId, msg, options) {
        if (!msg.content && !options?.uploads?.length) return;
        if ((msg as any)[HANDLED_FLAG]) return;

        const fromAutoTextUpload = hasAutoTextUpload(options) || hasLiveAutoTextUpload(channelId);
        const content = await getLongMessageContent(channelId, msg, options);
        if (content.length <= MAX_MESSAGE_LENGTH) return;

        if (fromAutoTextUpload) {
            this.openLongMessageEditor(channelId, content);
            return { cancel: true };
        }

        const chunks = splitContent(content, MAX_MESSAGE_LENGTH);
        if (chunks.length <= 1) return;

        (msg as any)[HANDLED_FLAG] = true;
        msg.content = chunks.shift()!;
        if (options) options.content = msg.content;
        stripAutoTextUploads(options);

        setTimeout(() => {
            sendFollowUps(channelId, msg, options, chunks);
        }, 0);
    }
});
