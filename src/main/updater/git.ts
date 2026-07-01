/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { IpcEvents } from "@shared/IpcEvents";
import { execFile as cpExecFile } from "child_process";
import { ipcMain } from "electron";
import { join } from "path";
import { promisify } from "util";

import { serializeErrors } from "./common";

const VENCORD_SRC_DIR = join(__dirname, "..");

const execFile = promisify(cpExecFile);

const isFlatpak = process.platform === "linux" && !!process.env.FLATPAK_ID;

if (process.platform === "darwin") process.env.PATH = `/usr/local/bin:${process.env.PATH}`;

function git(...args: string[]) {
    const opts = { cwd: VENCORD_SRC_DIR };

    if (isFlatpak) return execFile("flatpak-spawn", ["--host", "git", ...args], opts);
    else return execFile("git", args, opts);
}

async function gitConfig(key: string) {
    try {
        return (await git("config", "--get", key)).stdout.trim();
    } catch {
        return "";
    }
}

function executable(name: string) {
    return process.platform === "win32" ? `${name}.cmd` : name;
}

async function getCurrentBranch() {
    return (await git("branch", "--show-current")).stdout.trim();
}

async function getUpdateTarget() {
    const branch = await getCurrentBranch();
    const pushRemote = await gitConfig(`branch.${branch}.pushRemote`);
    if (pushRemote) {
        return {
            remote: pushRemote,
            remoteBranch: branch,
            ref: `${pushRemote}/${branch}`
        };
    }

    const remote = await gitConfig(`branch.${branch}.remote`) || "origin";
    const merge = await gitConfig(`branch.${branch}.merge`);
    const remoteBranch = merge.replace(/^refs\/heads\//, "") || branch;

    return {
        remote,
        remoteBranch,
        ref: `${remote}/${remoteBranch}`
    };
}

async function getRepo() {
    const { remote } = await getUpdateTarget();
    const res = await git("remote", "get-url", remote);
    return res.stdout.trim()
        .replace(/git@(.+):/, "https://$1/")
        .replace(/\.git$/, "");
}

async function calculateGitChanges() {
    const { remote, remoteBranch, ref } = await getUpdateTarget();

    await git("fetch", remote);

    const existsOnRemote = (await git("ls-remote", remote, remoteBranch)).stdout.length > 0;
    if (!existsOnRemote) return [];

    const res = await git("log", `HEAD..${ref}`, "--pretty=format:%an/%h/%s");

    const commits = res.stdout.trim();
    return commits ? commits.split("\n").map(line => {
        const [author, hash, ...rest] = line.split("/");
        return {
            hash, author,
            message: rest.join("/").split("\n")[0]
        };
    }) : [];
}

async function pull() {
    const { remote, remoteBranch } = await getUpdateTarget();
    const res = await git("pull", "--rebase", remote, remoteBranch);
    const output = res.stdout + res.stderr;

    return !/Already up to date|Current branch .* is up to date/.test(output);
}

async function build() {
    const opts = { cwd: VENCORD_SRC_DIR };

    if (isFlatpak) await execFile("flatpak-spawn", ["--host", "pnpm", "install"], opts);
    else await execFile(executable("pnpm"), ["install"], opts);

    const command = isFlatpak ? "flatpak-spawn" : "node";
    const args = isFlatpak ? ["--host", "node", "scripts/build/build.mjs"] : ["scripts/build/build.mjs"];

    if (IS_DEV) args.push("--dev");

    const res = await execFile(command, args, opts);

    return !res.stderr.includes("Build failed");
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(getRepo));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(calculateGitChanges));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors(pull));
ipcMain.handle(IpcEvents.BUILD, serializeErrors(build));
