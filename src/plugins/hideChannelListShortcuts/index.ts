/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

type ShortcutKind = "events" | "serverBoosts";
type HideReason = ShortcutKind | "separator";

const HIDDEN_ATTR = "data-vc-hide-channel-list-shortcut";
const PREV_DISPLAY_ATTR = "data-vc-hide-channel-list-shortcut-prev-display";
const PREV_PRIORITY_ATTR = "data-vc-hide-channel-list-shortcut-prev-priority";
const GAP_ATTR = "data-vc-hide-channel-list-shortcut-gap";
const PREV_MARGIN_TOP_ATTR = "data-vc-hide-channel-list-shortcut-prev-margin-top";
const PREV_MARGIN_TOP_PRIORITY_ATTR = "data-vc-hide-channel-list-shortcut-prev-margin-top-priority";
const TOP_GAP_PX = 8;

let observer: MutationObserver | null = null;
let frameId = 0;

const settings = definePluginSettings({
    hideEvents: {
        type: OptionType.BOOLEAN,
        description: "Hide the Events entry in the channel list",
        default: true,
        onChange: scheduleApply
    },
    hideServerBoosts: {
        type: OptionType.BOOLEAN,
        description: "Hide the Server Boosts entry in the channel list",
        default: true,
        onChange: scheduleApply
    }
});

function normalizeLabel(text: string | null | undefined) {
    return text?.replace(/\s+/g, " ").trim() ?? "";
}

function matchesShortcutLabel(label: string, prefix: string) {
    const normalized = normalizeLabel(label).toLowerCase();
    const expected = prefix.toLowerCase();
    return normalized === expected || normalized.startsWith(`${expected} `);
}

function getShortcutKindFromLabel(label: string): ShortcutKind | null {
    if (matchesShortcutLabel(label, "Events") && settings.store.hideEvents)
        return "events";

    if (matchesShortcutLabel(label, "Server Boosts") && settings.store.hideServerBoosts)
        return "serverBoosts";

    return null;
}

function getShortcutKindFromHref(href: string | null): ShortcutKind | null {
    if (!href)
        return null;

    const normalized = href.toLowerCase();
    if (!normalized.includes("/channels/"))
        return null;

    if (
        settings.store.hideEvents &&
        (normalized.includes("/events") || normalized.includes("guild-events"))
    ) {
        return "events";
    }

    if (
        settings.store.hideServerBoosts &&
        (
            normalized.includes("/premium/subscriptions") ||
            normalized.includes("premium-subscriptions") ||
            normalized.includes("server-boost")
        )
    ) {
        return "serverBoosts";
    }

    return null;
}

function isInChannelList(el: Element) {
    return Boolean(
        el.closest("[data-list-id]") ||
        el.closest("[role='tree']") ||
        el.closest("[aria-label*='Channels']") ||
        el.closest("nav")
    );
}

function isProbablyChannelListShortcut(anchor: HTMLAnchorElement) {
    const href = anchor.getAttribute("href");
    if (!href?.includes("/channels/"))
        return false;

    return isInChannelList(anchor);
}

function getHideTarget(el: Element) {
    return el.closest<HTMLElement>("li,[role='listitem'],[role='treeitem']") ?? el as HTMLElement;
}

function hideTarget(target: HTMLElement, kind: HideReason) {
    if (target.hasAttribute(HIDDEN_ATTR))
        return;

    target.setAttribute(HIDDEN_ATTR, kind);
    target.setAttribute(PREV_DISPLAY_ATTR, target.style.getPropertyValue("display"));
    target.setAttribute(PREV_PRIORITY_ATTR, target.style.getPropertyPriority("display"));
    target.style.setProperty("display", "none", "important");
}

function isVisibleElement(el: HTMLElement) {
    return el.style.display !== "none";
}

function isChannelRowCandidate(el: HTMLElement) {
    if (el.hasAttribute(HIDDEN_ATTR))
        return false;

    if (el.querySelector("a[href*='/channels/']"))
        return true;

    const label = normalizeLabel(el.getAttribute("aria-label") ?? el.textContent);
    return label.length > 0 && !getShortcutKindFromLabel(label);
}

function isDecorativeRow(el: HTMLElement) {
    if (el.hasAttribute(HIDDEN_ATTR))
        return false;

    if (!isVisibleElement(el))
        return false;

    if (el.querySelector("a[href], button, input, textarea, [role='button']"))
        return false;

    const label = normalizeLabel(el.getAttribute("aria-label") ?? el.textContent);
    return label.length === 0;
}

function cleanupOrphanedSeparators() {
    const parents = new Set<HTMLElement>();

    for (const el of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`)) {
        const parent = el.parentElement;
        if (parent)
            parents.add(parent);
    }

    for (const parent of parents) {
        const children = Array.from(parent.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
        const firstChannelIndex = children.findIndex(isChannelRowCandidate);
        if (firstChannelIndex < 0)
            continue;

        for (let i = 0; i < firstChannelIndex; i++) {
            const child = children[i];
            if (isDecorativeRow(child))
                hideTarget(child, "separator");
        }
    }
}

function hasHiddenShortcutRow(el: HTMLElement) {
    const reason = el.getAttribute(HIDDEN_ATTR);
    return reason === "events" || reason === "serverBoosts";
}

function clearAddedTopGaps() {
    for (const el of document.querySelectorAll<HTMLElement>(`[${GAP_ATTR}]`)) {
        const prevMarginTop = el.getAttribute(PREV_MARGIN_TOP_ATTR) ?? "";
        const prevPriority = el.getAttribute(PREV_MARGIN_TOP_PRIORITY_ATTR) ?? "";

        if (prevMarginTop.length > 0) {
            el.style.setProperty("margin-top", prevMarginTop, prevPriority);
        } else {
            el.style.removeProperty("margin-top");
        }

        el.removeAttribute(GAP_ATTR);
        el.removeAttribute(PREV_MARGIN_TOP_ATTR);
        el.removeAttribute(PREV_MARGIN_TOP_PRIORITY_ATTR);
    }
}

function applyTopGapForFirstChannelRows() {
    const parents = new Set<HTMLElement>();

    for (const el of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`)) {
        if (!hasHiddenShortcutRow(el))
            continue;

        const parent = el.parentElement;
        if (parent)
            parents.add(parent);
    }

    for (const parent of parents) {
        const children = Array.from(parent.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
        const firstChannelIndex = children.findIndex(child => isVisibleElement(child) && isChannelRowCandidate(child));
        if (firstChannelIndex < 0)
            continue;

        const hasVisibleRowBefore = children
            .slice(0, firstChannelIndex)
            .some(child => isVisibleElement(child) && !child.hasAttribute(HIDDEN_ATTR));
        if (hasVisibleRowBefore)
            continue;

        const firstChannelRow = children[firstChannelIndex];
        if (firstChannelRow.hasAttribute(GAP_ATTR))
            continue;

        firstChannelRow.setAttribute(GAP_ATTR, "1");
        firstChannelRow.setAttribute(PREV_MARGIN_TOP_ATTR, firstChannelRow.style.getPropertyValue("margin-top"));
        firstChannelRow.setAttribute(PREV_MARGIN_TOP_PRIORITY_ATTR, firstChannelRow.style.getPropertyPriority("margin-top"));
        firstChannelRow.style.setProperty("margin-top", `${TOP_GAP_PX}px`, "important");
    }
}

function restoreHiddenRows() {
    clearAddedTopGaps();

    for (const el of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`)) {
        const prevDisplay = el.getAttribute(PREV_DISPLAY_ATTR) ?? "";
        const prevPriority = el.getAttribute(PREV_PRIORITY_ATTR) ?? "";

        if (prevDisplay.length > 0) {
            el.style.setProperty("display", prevDisplay, prevPriority);
        } else {
            el.style.removeProperty("display");
        }

        el.removeAttribute(HIDDEN_ATTR);
        el.removeAttribute(PREV_DISPLAY_ATTR);
        el.removeAttribute(PREV_PRIORITY_ATTR);
    }
}

function applyHiding() {
    if (!document.body)
        return;

    restoreHiddenRows();

    if (!settings.store.hideEvents && !settings.store.hideServerBoosts)
        return;

    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        if (!isProbablyChannelListShortcut(anchor))
            continue;

        const kind = getShortcutKindFromHref(anchor.getAttribute("href"))
            ?? getShortcutKindFromLabel(anchor.getAttribute("aria-label") ?? "")
            ?? getShortcutKindFromLabel(anchor.textContent ?? "");
        if (!kind)
            continue;

        const target = getHideTarget(anchor);
        hideTarget(target, kind);
    }

    // Fallback for Discord layouts where these entries are rendered as treeitems/buttons without anchors
    for (const row of document.querySelectorAll<HTMLElement>("[role='treeitem'], li, [role='listitem']")) {
        if (!isInChannelList(row))
            continue;

        const kind = getShortcutKindFromLabel(row.getAttribute("aria-label") ?? "")
            ?? getShortcutKindFromLabel(row.textContent ?? "");
        if (!kind)
            continue;

        hideTarget(getHideTarget(row), kind);
    }

    cleanupOrphanedSeparators();
    applyTopGapForFirstChannelRows();
}

function scheduleApply() {
    if (frameId || !document.body)
        return;

    frameId = requestAnimationFrame(() => {
        frameId = 0;
        applyHiding();
    });
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
}

export default definePlugin({
    name: "HideChannelListShortcuts",
    description: "Hide the Events and Server Boosts entries at the top of the channel list",
    authors: [Devs.marcmy],
    requiresRestart: false,
    settings,

    start() {
        stopObserver();

        observer = new MutationObserver(() => scheduleApply());
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        scheduleApply();
    },

    stop() {
        stopObserver();

        if (frameId) {
            cancelAnimationFrame(frameId);
            frameId = 0;
        }

        restoreHiddenRows();
    }
});
