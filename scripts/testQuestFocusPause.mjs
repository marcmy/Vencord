/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const executablePath = process.env.BROWSER_PATH ?? [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome"
].find(path => existsSync(path));
assert.ok(executablePath, "Set BROWSER_PATH to a Chromium executable to run the DOM regression tests.");

const { outputFiles } = await build({
    stdin: {
        contents: readFileSync("src/plugins/disableQuestFocusPause/index.ts", "utf8")
            + "\nexport { isQuestModalCandidate, collectQuestVideos };",
        resolveDir: "src/plugins/disableQuestFocusPause",
        loader: "ts"
    },
    bundle: true,
    format: "iife",
    globalName: "questHarness",
    write: false,
    plugins: [{
        name: "discord-fixture",
        setup(builder) {
            builder.onResolve({ filter: /^@utils\/(constants|types)$/ }, args => ({ path: args.path, namespace: "fixture" }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
                contents: args.path.endsWith("types")
                    ? "export default plugin => plugin;"
                    : "export const Devs = { marcmy: {} };"
            }));
        }
    }]
});

const browser = await puppeteer.launch({ executablePath, headless: true });
try {
    const page = await browser.newPage();
    await page.setContent("<main><input id='composer'><button id='picker'>Emoji picker</button></main>");
    await page.addScriptTag({ content: outputFiles[0].text });
    const result = await page.evaluate(async () => {
        const { default: plugin, isQuestModalCandidate, collectQuestVideos } = questHarness;
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const dialog = (text, className = "") => {
            const modal = document.createElement("div");
            modal.setAttribute("role", "dialog");
            modal.className = className;
            modal.append(text, document.createElement("video"));
            modal.querySelector("video").play = () => Promise.resolve();
            document.body.append(modal);
            return modal;
        };
        const button = () => document.querySelector("[aria-label='Minimize quest video']");
        const originalHasFocus = document.hasFocus;
        const quest = dialog("Video Quest: Learn more");
        const video = quest.querySelector("video");
        plugin.start();
        await settle();
        check(button()?.parentElement === quest, "Minimize button must belong to its quest dialog");
        check(!button().hidden, "Quest button should initially be visible");
        check(getComputedStyle(quest).position === "relative", "Static quest dialogs need a positioned anchor");

        const settings = dialog("Settings: Learn more. Claim reward.", "modal-settings");
        await settle();
        check(!isQuestModalCandidate(settings), "Generic settings copy must not identify a quest");
        check(collectQuestVideos().length === 1, "Settings videos must not be tracked");
        check(button().hidden, "Quest button must hide behind another dialog");
        settings.remove();
        await settle();
        check(!button().hidden, "Closing settings must reveal the quest button");

        quest.setAttribute("aria-hidden", "true");
        await settle();
        check(button().hidden, "Hidden quest dialog must not expose controls");
        quest.removeAttribute("aria-hidden");
        await settle();
        check(!button().hidden, "Quest controls should recover when the dialog is exposed");

        let inputBlurs = 0;
        const composer = document.getElementById("composer");
        const picker = document.getElementById("picker");
        composer.addEventListener("blur", () => inputBlurs++);
        composer.focus();
        picker.focus();
        check(inputBlurs === 1, "Element blur must reach the input listener during quest playback");
        let windowBlurs = 0;
        const onWindowBlur = () => windowBlurs++;
        window.addEventListener("blur", onWindowBlur);
        window.dispatchEvent(new FocusEvent("blur"));
        check(windowBlurs === 0, "Actual window blur must still be blocked during quest playback");

        button().click();
        await settle();
        check(document.querySelector(".vc-quest-mini-player"), "Minimizing must still create the floating player");
        check(video.style.position === "fixed", "The original video must be used by the floating player");
        Array.from(document.querySelectorAll(".vc-quest-mini-player button")).find(node => node.textContent === "Restore").click();
        await settle();
        check(!document.querySelector(".vc-quest-mini-player"), "Restore must remove the floating player");
        check(video.style.position === "", "Restore must restore video styles");

        let buttonMutations = 0;
        const observer = new MutationObserver(records => { buttonMutations += records.length; });
        observer.observe(button(), { attributes: true });
        await settle();
        await settle();
        observer.disconnect();
        check(buttonMutations === 0, "Observer scans must not rewrite the hidden attribute indefinitely");

        quest.remove();
        await settle();
        check(!button(), "Closing a quest must remove its controls");
        check(quest.style.position === "", "Closing a quest must restore modal positioning");
        window.dispatchEvent(new FocusEvent("blur"));
        check(windowBlurs === 1, "Window blur must pass through after closing the quest");

        const container = document.createElement("div");
        container.className = "modal-container";
        document.body.append(container);
        const otherQuest = dialog("Video Quest: Claim reward");
        const ordinary = dialog("Settings: Learn more");
        container.append(otherQuest, ordinary);
        check(collectQuestVideos().length === 1, "Shared modal wrappers must not classify sibling settings videos");
        await settle();
        button()?.click();
        plugin.stop();
        check(!button() && !document.querySelector(".vc-quest-mini-player"), "Disabling the plugin must remove all injected UI");
        check(otherQuest.style.position === "", "Disabling must restore modal positioning");
        check(document.hasFocus === originalHasFocus, "Disabling must restore focus overrides");
        window.removeEventListener("blur", onWindowBlur);
        return "Quest dialog ownership, visibility, focus propagation, minimize/restore and cleanup regressions passed.";
    });
    console.log(result);
} finally {
    await browser.close();
}
