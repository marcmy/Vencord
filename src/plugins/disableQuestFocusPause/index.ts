/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

type DocumentPropertyKey = "hidden" | "webkitHidden" | "visibilityState" | "webkitVisibilityState";
type EventBinding = {
    target: Document | Window;
    type: string;
    listener: EventListener;
};
type VideoListeners = {
    pause: EventListener;
    ended: EventListener;
};
type OverrideState = {
    ownDescriptor: PropertyDescriptor | undefined;
    sourceDescriptor: PropertyDescriptor | undefined;
};

const LOG_PREFIX = "[DisableQuestFocusPause]";
const QUEST_MODAL_MARKERS = [
    "claim reward",
    "learn more",
    "resume to continue progress",
    "we paused the video while you are away"
];

let observer: MutationObserver | null = null;
let scanFrameId = 0;
let resumeFrameId = 0;
let recoveryDispatchDepth = 0;

let activeQuestVideos: HTMLVideoElement[] = [];

const documentOverrides = new Map<DocumentPropertyKey, OverrideState>();
let hasFocusOverride: OverrideState | null = null;

const eventBindings: EventBinding[] = [];
const trackedVideoListeners = new Map<HTMLVideoElement, VideoListeners>();

function warn(message: string, error?: unknown) {
    console.warn(LOG_PREFIX, message, error);
}

function normalizeText(text: string | null | undefined) {
    return text?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
}

function getPropertyDescriptor(target: object, key: PropertyKey): PropertyDescriptor | undefined {
    let current: object | null = target;
    while (current) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor) return descriptor;
        current = Object.getPrototypeOf(current);
    }

    return void 0;
}

function readDescriptorValue(descriptor: PropertyDescriptor | undefined, target: object) {
    if (!descriptor) return void 0;
    if ("get" in descriptor && descriptor.get) return descriptor.get.call(target);
    return descriptor.value;
}

function restoreOwnProperty(target: object, key: PropertyKey, state: OverrideState | null) {
    if (!state) return;

    if (state.ownDescriptor) {
        Object.defineProperty(target, key, state.ownDescriptor);
    } else {
        Reflect.deleteProperty(target, key);
    }
}

function shouldSpoofFocus() {
    return activeQuestVideos.length > 0;
}

function readOriginalDocumentProperty(key: DocumentPropertyKey) {
    return readDescriptorValue(documentOverrides.get(key)?.sourceDescriptor, document);
}

function installDocumentPropertyOverride(key: DocumentPropertyKey, overrideValue: boolean | string) {
    if (documentOverrides.has(key))
        return;

    const state = {
        ownDescriptor: Object.getOwnPropertyDescriptor(document, key),
        sourceDescriptor: getPropertyDescriptor(document, key)
    };

    documentOverrides.set(key, state);

    try {
        Object.defineProperty(document, key, {
            configurable: true,
            enumerable: state.sourceDescriptor?.enumerable ?? state.ownDescriptor?.enumerable ?? false,
            get() {
                return shouldSpoofFocus() ? overrideValue : readOriginalDocumentProperty(key);
            }
        });
    } catch (error) {
        warn(`Failed overriding document.${key}`, error);
    }
}

function installHasFocusOverride() {
    if (hasFocusOverride)
        return;

    hasFocusOverride = {
        ownDescriptor: Object.getOwnPropertyDescriptor(document, "hasFocus"),
        sourceDescriptor: getPropertyDescriptor(document, "hasFocus")
    };

    try {
        Object.defineProperty(document, "hasFocus", {
            configurable: true,
            enumerable: hasFocusOverride.sourceDescriptor?.enumerable ?? hasFocusOverride.ownDescriptor?.enumerable ?? false,
            value() {
                if (shouldSpoofFocus()) return true;

                const original = hasFocusOverride?.sourceDescriptor?.value;
                if (typeof original === "function") {
                    return original.call(document);
                }

                return true;
            }
        });
    } catch (error) {
        warn("Failed overriding document.hasFocus()", error);
    }
}

function installFocusOverrides() {
    installDocumentPropertyOverride("hidden", false);
    installDocumentPropertyOverride("visibilityState", "visible");

    if ("webkitHidden" in document) {
        installDocumentPropertyOverride("webkitHidden", false);
    }

    if ("webkitVisibilityState" in document) {
        installDocumentPropertyOverride("webkitVisibilityState", "visible");
    }

    installHasFocusOverride();
}

function restoreFocusOverrides() {
    for (const [key, state] of documentOverrides) {
        restoreOwnProperty(document, key, state);
    }

    documentOverrides.clear();

    restoreOwnProperty(document, "hasFocus", hasFocusOverride);
    hasFocusOverride = null;
}

function scheduleResume() {
    if (resumeFrameId)
        return;

    resumeFrameId = requestAnimationFrame(() => {
        resumeFrameId = 0;
        resumeQuestVideos();
    });
}

function resumeQuestVideos() {
    for (const video of activeQuestVideos) {
        if (!video.isConnected || video.ended || !video.paused)
            continue;

        void video.play().catch(error => warn("Failed resuming quest video playback", error));
    }
}

function addBlockingListener(target: Document | Window, type: string, listener: EventListener) {
    target.addEventListener(type, listener, true);
    eventBindings.push({ target, type, listener });
}

function stopBlockingListeners() {
    for (const binding of eventBindings) {
        binding.target.removeEventListener(binding.type, binding.listener, true);
    }

    eventBindings.length = 0;
}

function dispatchRecoveryEvents() {
    recoveryDispatchDepth++;

    try {
        document.dispatchEvent(new Event("visibilitychange"));
        if ("onwebkitvisibilitychange" in document) {
            document.dispatchEvent(new Event("webkitvisibilitychange"));
        }
        window.dispatchEvent(new FocusEvent("focus"));
    } catch (error) {
        warn("Failed dispatching recovery focus events", error);
    } finally {
        recoveryDispatchDepth--;
    }
}

function handleBlockedFocusEvent(event: Event) {
    if (!shouldSpoofFocus() || recoveryDispatchDepth > 0)
        return;

    event.stopImmediatePropagation();
    event.stopPropagation();
    scheduleResume();
}

function installBlockingListeners() {
    addBlockingListener(document, "visibilitychange", handleBlockedFocusEvent);
    addBlockingListener(window, "blur", handleBlockedFocusEvent);
    addBlockingListener(window, "pagehide", handleBlockedFocusEvent);

    if ("onwebkitvisibilitychange" in document) {
        addBlockingListener(document, "webkitvisibilitychange", handleBlockedFocusEvent);
    }
}

function isQuestModalCandidate(root: HTMLElement) {
    const text = normalizeText(root.textContent);
    if (!text) return false;

    if (QUEST_MODAL_MARKERS.some(marker => text.includes(marker))) {
        return true;
    }

    return text.includes("quest") && text.includes("learn more");
}

function collectQuestVideos() {
    const matches = new Set<HTMLVideoElement>();
    const modalSelectors = [
        "[aria-modal='true']",
        "[role='dialog']",
        "[class*='modal']"
    ];

    for (const modal of document.querySelectorAll<HTMLElement>(modalSelectors.join(","))) {
        if (!modal.querySelector("video"))
            continue;

        if (!isQuestModalCandidate(modal))
            continue;

        for (const video of modal.querySelectorAll<HTMLVideoElement>("video")) {
            matches.add(video);
        }
    }

    return Array.from(matches);
}

function detachVideoListeners(video: HTMLVideoElement, listeners: VideoListeners) {
    video.removeEventListener("pause", listeners.pause);
    video.removeEventListener("ended", listeners.ended);
}

function syncTrackedVideos(videos: HTMLVideoElement[]) {
    const current = new Set(videos);

    for (const [video, listeners] of trackedVideoListeners) {
        if (current.has(video) && video.isConnected)
            continue;

        detachVideoListeners(video, listeners);
        trackedVideoListeners.delete(video);
    }

    for (const video of current) {
        if (trackedVideoListeners.has(video))
            continue;

        const pause = () => {
            if (!shouldSpoofFocus())
                return;

            scheduleResume();
        };

        const ended = () => scheduleScan();

        video.addEventListener("pause", pause);
        video.addEventListener("ended", ended);

        trackedVideoListeners.set(video, { pause, ended });
    }
}

function stopTrackingVideos() {
    for (const [video, listeners] of trackedVideoListeners) {
        detachVideoListeners(video, listeners);
    }

    trackedVideoListeners.clear();
    activeQuestVideos = [];
}

function refreshQuestVideos() {
    const wasSpoofing = shouldSpoofFocus();

    activeQuestVideos = collectQuestVideos();
    syncTrackedVideos(activeQuestVideos);

    const isSpoofing = shouldSpoofFocus();
    if (!wasSpoofing && isSpoofing) {
        dispatchRecoveryEvents();
    }

    if (isSpoofing) {
        scheduleResume();
    }
}

function scheduleScan() {
    if (scanFrameId || !document.body)
        return;

    scanFrameId = requestAnimationFrame(() => {
        scanFrameId = 0;
        refreshQuestVideos();
    });
}

function startObserver() {
    if (!document.body)
        return;

    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
}

export default definePlugin({
    name: "DisableQuestFocusPause",
    description: "Prevents Discord quests from pausing their video when the window loses focus.",
    authors: [Devs.marcmy],
    requiresRestart: false,

    start() {
        installFocusOverrides();
        installBlockingListeners();
        startObserver();
        scheduleScan();
    },

    stop() {
        stopObserver();
        stopBlockingListeners();
        stopTrackingVideos();
        restoreFocusOverrides();

        if (scanFrameId) {
            cancelAnimationFrame(scanFrameId);
            scanFrameId = 0;
        }

        if (resumeFrameId) {
            cancelAnimationFrame(resumeFrameId);
            resumeFrameId = 0;
        }
    }
});
