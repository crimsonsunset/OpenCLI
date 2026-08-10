const OWN_PREFIX = chrome.runtime.getURL("");
function stripForeignExtensionEmbeds(root = document) {
  let removed = 0;
  const selector = 'iframe[src^="chrome-extension:"], frame[src^="chrome-extension:"], embed[src^="chrome-extension:"], object[data^="chrome-extension:"]';
  for (const el of Array.from(root.querySelectorAll(selector))) {
    const src = el.getAttribute("src") || el.getAttribute("data") || "";
    if (src.startsWith(OWN_PREFIX)) continue;
    el.remove();
    removed += 1;
  }
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const shadow = el.shadowRoot;
    if (shadow) removed += stripForeignExtensionEmbeds(shadow);
  }
  return removed;
}
function watchForeignEmbeds() {
  stripForeignExtensionEmbeds();
  const obs = new MutationObserver(() => {
    stripForeignExtensionEmbeds();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}
async function evalInIsolated(code) {
  const value = (0, eval)(code);
  return await value;
}
watchForeignEmbeds();
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (message.type === "opencli:strip-frames") {
    const removed = stripForeignExtensionEmbeds();
    sendResponse({ ok: true, removed });
    return false;
  }
  if (message.type === "opencli:eval" && typeof message.code === "string") {
    void evalInIsolated(message.code).then((value) => sendResponse({ ok: true, value })).catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error });
    });
    return true;
  }
  return false;
});
