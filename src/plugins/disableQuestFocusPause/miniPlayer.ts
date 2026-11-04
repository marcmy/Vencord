/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type SavedStyle = { value: string; priority: string; };
type MiniPlayer = {
    video: HTMLVideoElement;
    modal: HTMLElement;
    minimizeButton: HTMLButtonElement;
    floatingWindow: HTMLDivElement | null;
    styles: Map<HTMLElement, Map<string, SavedStyle>>;
    minimized: boolean;
    x: number;
    y: number;
    width: number;
    aspectRatio: number;
};

const MINI_HEADER_HEIGHT = 34;
const MINI_Z_INDEX = 2147483000;
let miniPlayer: MiniPlayer | null = null;

function saveAndSetStyle(player: MiniPlayer, element: HTMLElement, property: string, value: string) {
    let saved = player.styles.get(element);
    if (!saved) {
        saved = new Map();
        player.styles.set(element, saved);
    }
    if (!saved.has(property)) {
        saved.set(property, {
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property)
        });
    }
    element.style.setProperty(property, value, "important");
}

function restoreMiniStyles(player: MiniPlayer) {
    for (const [element, properties] of player.styles) {
        for (const [property, old] of properties) {
            if (old.value) element.style.setProperty(property, old.value, old.priority);
            else element.style.removeProperty(property);
        }
    }
    player.styles.clear();
}

function findQuestDialog(video: HTMLVideoElement, isQuestModalCandidate: (root: HTMLElement) => boolean) {
    const dialog = video.closest<HTMLElement>("[role='dialog'], [aria-modal='true']");
    if (dialog && isQuestModalCandidate(dialog)) return dialog;

    for (let parent = video.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (parent.matches("[class*='modal']") && isQuestModalCandidate(parent)) return parent;
    }
    return null;
}

// Discord can insert the backdrop and the modal into separate branches. Styling
// the nearest "layer" is not enough: the actual overlay may remain interactive.
// Restrict changes to the modal portal branch, never to the application shell.
function findQuestOverlayAncestors(video: HTMLVideoElement): HTMLElement[] {
    const appMount = document.getElementById("app-mount");
    const appChrome = Array.from(document.querySelectorAll<HTMLElement>(
        "#app-mount [data-list-id='guildsnav'], #app-mount nav, #app-mount [role='main']"
    )).filter(element => !element.contains(video));
    const ancestors: HTMLElement[] = [];

    for (let current = video.parentElement; current && current !== document.body && current !== document.documentElement; current = current.parentElement) {
        if (current === appMount || current.id === "app-mount") break;
        // A shared application ancestor would hide the real Discord UI.
        if (appChrome.some(element => current.contains(element))) break;
        ancestors.push(current);
    }
    return ancestors;
}

function hideQuestOverlay(player: MiniPlayer) {
    const ancestors = findQuestOverlayAncestors(player.video);
    for (const ancestor of ancestors) {
        saveAndSetStyle(player, ancestor, "transform", "none");
        saveAndSetStyle(player, ancestor, "filter", "none");
        saveAndSetStyle(player, ancestor, "perspective", "none");
        saveAndSetStyle(player, ancestor, "contain", "none");
        saveAndSetStyle(player, ancestor, "will-change", "auto");
        saveAndSetStyle(player, ancestor, "overflow", "visible");
        saveAndSetStyle(player, ancestor, "visibility", "hidden");
        saveAndSetStyle(player, ancestor, "pointer-events", "none");
    }

    // Backdrops may be siblings of the modal portal instead of descendants.
    // Only suppress explicit backdrop nodes, not application content.
    for (const ancestor of ancestors) {
        const parent = ancestor.parentElement;
        if (!parent) continue;
        for (const sibling of parent.children) {
            if (!(sibling instanceof HTMLElement) || sibling === ancestor) continue;
            if (sibling.matches("[class*='backdrop' i], [data-testid*='backdrop' i]")) {
                saveAndSetStyle(player, sibling, "visibility", "hidden");
                saveAndSetStyle(player, sibling, "pointer-events", "none");
            }
        }
    }
}

function clampMiniPosition(player: MiniPlayer) {
    const height = MINI_HEADER_HEIGHT + player.width / player.aspectRatio;
    player.x = Math.max(0, Math.min(player.x, window.innerWidth - player.width));
    player.y = Math.max(0, Math.min(player.y, window.innerHeight - height));
}

function layoutMiniPlayer(player: MiniPlayer) {
    if (!player.minimized || !player.floatingWindow) return;
    const maxWidth = Math.max(160, Math.min(window.innerWidth - 12, (window.innerHeight - MINI_HEADER_HEIGHT - 12) * player.aspectRatio));
    player.width = Math.min(player.width, maxWidth);
    clampMiniPosition(player);

    const height = player.width / player.aspectRatio;
    Object.assign(player.floatingWindow.style, {
        left: `${player.x}px`,
        top: `${player.y}px`,
        width: `${player.width}px`,
        height: `${height + MINI_HEADER_HEIGHT}px`
    });
    for (const [property, value] of Object.entries({
        left: `${player.x}px`,
        top: `${player.y + MINI_HEADER_HEIGHT}px`,
        width: `${player.width}px`,
        height: `${height}px`
    })) {
        saveAndSetStyle(player, player.video, property, value);
    }
}

function restoreQuestModal() {
    const player = miniPlayer;
    if (!player || !player.minimized) return;

    player.floatingWindow?.remove();
    player.floatingWindow = null;
    restoreMiniStyles(player);
    player.minimized = false;
    player.minimizeButton.hidden = false;
    positionMinimizeButton(player);
}

function makeMiniButton(label: string, onClick: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = label;
    button.style.cssText = "border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;padding:4px 8px;font:inherit;";
    button.addEventListener("click", event => {
        event.stopPropagation();
        onClick();
    });
    return button;
}

function makeFloatingWindow(player: MiniPlayer) {
    const windowElement = document.createElement("div");
    windowElement.className = "vc-quest-mini-player";
    windowElement.style.cssText = `position:fixed;z-index:${MINI_Z_INDEX + 1};box-sizing:border-box;border:1px solid var(--background-tertiary,#313338);border-radius:10px;box-shadow:0 6px 28px #0008;pointer-events:none;`;

    const header = document.createElement("div");
    header.style.cssText = `height:${MINI_HEADER_HEIGHT}px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 6px 0 12px;background:var(--background-secondary,#2b2d31);color:var(--text-normal,#fff);border-radius:9px 9px 0 0;cursor:move;user-select:none;touch-action:none;pointer-events:auto;`;
    const title = document.createElement("span");
    title.textContent = "Quest video";
    title.style.cssText = "font:600 12px sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const restoreButton = makeMiniButton("Restore", restoreQuestModal);
    header.append(title, restoreButton);
    windowElement.append(header);

    const resizeHandle = document.createElement("div");
    resizeHandle.title = "Resize quest video";
    resizeHandle.setAttribute("role", "separator");
    resizeHandle.setAttribute("aria-label", "Resize quest video");
    resizeHandle.style.cssText = "position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;pointer-events:auto;touch-action:none;background:linear-gradient(135deg,transparent 64%,#b7b7c9 65%,#b7b7c9 69%,transparent 70%);";
    windowElement.append(resizeHandle);

    header.addEventListener("pointerdown", event => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        const originalX = player.x;
        const originalY = player.y;
        header.setPointerCapture(event.pointerId);
        const move = (next: PointerEvent) => {
            player.x = originalX + next.clientX - startX;
            player.y = originalY + next.clientY - startY;
            layoutMiniPlayer(player);
        };
        const finish = () => {
            header.removeEventListener("pointermove", move);
            header.removeEventListener("pointerup", finish);
            header.removeEventListener("pointercancel", finish);
        };
        header.addEventListener("pointermove", move);
        header.addEventListener("pointerup", finish);
        header.addEventListener("pointercancel", finish);
    });

    resizeHandle.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const originalWidth = player.width;
        resizeHandle.setPointerCapture(event.pointerId);
        const move = (next: PointerEvent) => {
            player.width = Math.max(240, originalWidth + next.clientX - startX);
            layoutMiniPlayer(player);
        };
        const finish = () => {
            resizeHandle.removeEventListener("pointermove", move);
            resizeHandle.removeEventListener("pointerup", finish);
            resizeHandle.removeEventListener("pointercancel", finish);
        };
        resizeHandle.addEventListener("pointermove", move);
        resizeHandle.addEventListener("pointerup", finish);
        resizeHandle.addEventListener("pointercancel", finish);
    });

    document.body.append(windowElement);
    return windowElement;
}

function minimizeQuestModal() {
    const player = miniPlayer;
    if (!player || player.minimized || !player.modal.isConnected) return;

    const bounds = player.video.getBoundingClientRect();
    player.aspectRatio = player.video.videoWidth && player.video.videoHeight
        ? player.video.videoWidth / player.video.videoHeight
        : bounds.width && bounds.height ? bounds.width / bounds.height : 16 / 9;
    player.width = Math.min(360, Math.max(240, window.innerWidth - 12));
    player.x = window.innerWidth - player.width - 20;
    player.y = window.innerHeight - MINI_HEADER_HEIGHT - player.width / player.aspectRatio - 20;
    player.minimized = true;
    player.minimizeButton.hidden = true;

    // Preserve the actual React video and progress listeners while allowing
    // pointer events to reach Discord behind the now-hidden modal portal.
    hideQuestOverlay(player);

    saveAndSetStyle(player, player.video, "position", "fixed");
    saveAndSetStyle(player, player.video, "z-index", String(MINI_Z_INDEX));
    saveAndSetStyle(player, player.video, "max-width", "none");
    saveAndSetStyle(player, player.video, "max-height", "none");
    saveAndSetStyle(player, player.video, "object-fit", "contain");
    saveAndSetStyle(player, player.video, "transform", "none");
    saveAndSetStyle(player, player.video, "visibility", "visible");
    saveAndSetStyle(player, player.video, "pointer-events", "auto");

    player.floatingWindow = makeFloatingWindow(player);
    layoutMiniPlayer(player);
}

function positionMinimizeButton(player: MiniPlayer) {
    if (player.minimized) return;
    const bounds = player.modal.getBoundingClientRect();
    const x = Math.max(8, Math.min(window.innerWidth - 160, bounds.right - 170));
    const y = Math.max(8, Math.min(window.innerHeight - 36, bounds.top + 12));
    player.minimizeButton.style.left = `${x}px`;
    player.minimizeButton.style.top = `${y}px`;
}

export function stopMiniPlayer() {
    const player = miniPlayer;
    if (!player) return;
    restoreQuestModal();
    player.minimizeButton.remove();
    miniPlayer = null;
}

export function syncMiniPlayer(videos: HTMLVideoElement[], isQuestModalCandidate: (root: HTMLElement) => boolean) {
    const video = videos[0];
    const modal = video && findQuestDialog(video, isQuestModalCandidate);
    if (!video || !modal) {
        stopMiniPlayer();
        return;
    }
    if (miniPlayer?.video === video && miniPlayer.modal === modal) {
        positionMinimizeButton(miniPlayer);
        return;
    }

    stopMiniPlayer();
    const minimizeButton = makeMiniButton("↘ Minimize video", minimizeQuestModal);
    minimizeButton.setAttribute("aria-label", "Minimize quest video");
    minimizeButton.style.cssText += `position:fixed;z-index:${MINI_Z_INDEX + 2};padding:7px 10px;background:var(--button-secondary-background,#4e5058);color:#fff;box-shadow:0 2px 12px #0007;font:600 12px sans-serif;`;
    document.body.append(minimizeButton);
    miniPlayer = {
        video, modal, minimizeButton, floatingWindow: null,
        styles: new Map(), minimized: false,
        x: 0, y: 0, width: 360, aspectRatio: 16 / 9
    };
    positionMinimizeButton(miniPlayer);
}

export function handleMiniResize() {
    if (miniPlayer?.minimized) layoutMiniPlayer(miniPlayer);
    else if (miniPlayer) positionMinimizeButton(miniPlayer);
}

