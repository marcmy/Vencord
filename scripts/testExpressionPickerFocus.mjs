/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const executablePath = process.env.BROWSER_PATH ?? [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"
].find(path => existsSync(path));
assert.ok(executablePath, "Set BROWSER_PATH to a Chromium executable.");
const { outputFiles } = await build({
    entryPoints: ["src/plugins/fixExpressionPickerFocus/index.ts"],
    bundle: true, format: "iife", globalName: "pickerFocusPlugin", write: false,
    plugins: [{
        name: "discord-fixture",
        setup(builder) {
            builder.onResolve({ filter: /^@utils\/(constants|types)$/ }, args => ({ path: args.path, namespace: "fixture" }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
                contents: args.path.endsWith("types") ? "export default plugin => plugin;" : "export const Devs = { marcmy: {} };"
            }));
        }
    }]
});
const browser = await puppeteer.launch({ executablePath, headless: true });
try {
    const page = await browser.newPage();
    await page.setContent(`<form id="composer">
        <div id="editor" role="textbox" contenteditable="true">draft</div>
        <div id="emoji" class="emojiButton_example" role="button" tabindex="0" aria-controls="picker" aria-expanded="false"></div>
        <div id="gif" role="button" tabindex="0" aria-controls="picker" aria-expanded="false"></div>
        <div id="other" role="button" tabindex="0" aria-controls="other-dialog" aria-expanded="false"></div>
        <input id="search">
        </form>
        <button id="reaction" aria-controls="picker" aria-expanded="false">React</button>
        <form><div id="otherEditor" role="textbox" contenteditable="true">another draft</div></form>`);
    await page.addScriptTag({ content: outputFiles[0].text });
    console.log(await page.evaluate(() => {
        const plugin = pickerFocusPlugin.default;
        const check = (condition, message) => { if (!condition) throw Error(message); };
        const editor = document.getElementById("editor");
        const emoji = document.getElementById("emoji");
        const gif = document.getElementById("gif");
        const patch = plugin.patches[0].replacement;
        const matcher = new RegExp(patch.match.source.replaceAll("\\i", "(?:[A-Za-z_$][\\w$]*)"));
        const original = "t?.isConnected?n.focus():n.focus({preventScroll:!0})";
        check([...original.matchAll(new RegExp(matcher.source, "g"))].length === 1, "Restoration expression must match exactly once");
        const replacement = original.replace(matcher, patch.replace.replaceAll("$self", "plugin"));
        const restore = Function("plugin", "t", "n", replacement);
        editor.focus();
        check(plugin.keepComposerFocus(emoji), "Emoji selection should preserve composer focus");
        check(plugin.keepComposerFocus(gif), "GIF selection should preserve composer focus");
        restore(plugin, emoji, emoji);
        check(document.activeElement === editor, "Patched restoration must not steal composer focus");
        let entered = false;
        editor.addEventListener("keydown", event => { if (event.key === "Enter") entered = true; });
        document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        check(entered, "Enter must still reach the composer");
        emoji.setAttribute("aria-expanded", "true");
        check(!plugin.keepComposerFocus(emoji), "An open picker must not be altered");
        emoji.setAttribute("aria-expanded", "false");
        check(!plugin.keepComposerFocus(document.getElementById("reaction")), "Reaction picker must not be altered");
        check(!plugin.keepComposerFocus(document.getElementById("other")), "Other composer dialogs must not be altered");
        document.getElementById("search").focus();
        check(!plugin.keepComposerFocus(emoji), "Other input focus must not be altered");
        document.getElementById("otherEditor").focus();
        check(!plugin.keepComposerFocus(emoji), "Another composer's focus must not be altered");
        emoji.focus();
        restore(plugin, emoji, emoji);
        check(document.activeElement === emoji, "Escape/dismiss without focusing the composer must preserve normal restoration");
        const removed = document.createElement("div");
        editor.focus();
        restore(plugin, removed, document.getElementById("other"));
        check(document.activeElement.id === "other", "Fallback preventScroll restoration must still work");
        check(editor.textContent === "draft", "Draft must remain unchanged");
        return "Expression picker focus, Enter routing, and normal focus-restoration regressions passed.";
    }));
} finally {
    await browser.close();
}
