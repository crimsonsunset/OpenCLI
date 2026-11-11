//#region src/content-bridge.ts
/**
* Isolated-world bridge for Amazon /dp recovery.
*
* Runs without the `scripting` permission (which Extensions Reloader does not
* grant on manifest bumps). Strips foreign chrome-extension embeds that block
* chrome.debugger.attach on request from the service worker.
*/
var OWN_PREFIX = chrome.runtime.getURL("");
/**
* Remove foreign extension iframes/frames/embeds that block chrome.debugger.attach.
* @param root - Document or shadow root to scan
* @returns Number of nodes removed
*/
function stripForeignExtensionEmbeds(root = document) {
	let removed = 0;
	for (const el of Array.from(root.querySelectorAll("iframe[src^=\"chrome-extension:\"], frame[src^=\"chrome-extension:\"], embed[src^=\"chrome-extension:\"], object[data^=\"chrome-extension:\"]"))) {
		if ((el.getAttribute("src") || el.getAttribute("data") || "").startsWith(OWN_PREFIX)) continue;
		el.remove();
		removed += 1;
	}
	for (const el of Array.from(root.querySelectorAll("*"))) {
		const shadow = el.shadowRoot;
		if (shadow) removed += stripForeignExtensionEmbeds(shadow);
	}
	return removed;
}
/**
* Evaluate page JS with Runtime.evaluate-like completion semantics.
* @param code - Source string (may be multi-statement; last value awaited)
*/
async function evalInIsolated(code) {
	return await (0, eval)(code);
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!message || typeof message !== "object") return false;
	if (message.type === "opencli:strip-frames") {
		sendResponse({
			ok: true,
			removed: stripForeignExtensionEmbeds()
		});
		return false;
	}
	if (message.type === "opencli:eval" && typeof message.code === "string") {
		evalInIsolated(message.code).then((value) => sendResponse({
			ok: true,
			value
		})).catch((err) => {
			sendResponse({
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			});
		});
		return true;
	}
	return false;
});
//#endregion
