/**
 * @template T
 * @param {T[]} arr
 * @param {(v: T) => boolean} predicate
 */
function removeFirst(arr, predicate) {
    const idx = arr.findIndex(predicate);
    if (idx !== -1) arr.splice(idx, 1);
}

chrome.webRequest.onHeadersReceived.addListener(
    ({ responseHeaders, type, url }) => {
        if (!responseHeaders) return;

        let hostname;
        try {
            hostname = new URL(url).hostname;
        } catch {
            return;
        }

        const isDiscord = hostname === "discord.com" || hostname.endsWith(".discord.com");

        if (type === "main_frame" && isDiscord) {
            // In main frame requests, the CSP needs to be removed to enable fetching of custom css
            // as desired by the user
            removeFirst(responseHeaders, h => h.name.toLowerCase() === "content-security-policy");
        } else if (type === "stylesheet" && hostname === "raw.githubusercontent.com") {
            // Most users will load css from GitHub, but GitHub doesn't set the correct content type,
            // so we fix it here
            removeFirst(responseHeaders, h => h.name.toLowerCase() === "content-type");
            responseHeaders.push({
                name: "Content-Type",
                value: "text/css"
            });
        }
        return { responseHeaders };
    },
    { urls: ["https://raw.githubusercontent.com/*", "*://*.discord.com/*"], types: ["main_frame", "stylesheet"] },
    ["blocking", "responseHeaders"]
);
