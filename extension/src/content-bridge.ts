/**
 * Isolated-world bridge for Amazon /dp recovery.
 *
 * Runs without the `scripting` permission (which Extensions Reloader does not
 * grant on manifest bumps). Strips foreign chrome-extension embeds that block
 * chrome.debugger.attach, and evaluates settle/read payloads when CDP is poisoned.
 */

const OWN_PREFIX = chrome.runtime.getURL('');

/**
 * Remove foreign extension iframes/frames/embeds that block chrome.debugger.attach.
 * @param root - Document or shadow root to scan
 * @returns Number of nodes removed
 */
function stripForeignExtensionEmbeds(root: ParentNode = document): number {
  let removed = 0;
  const selector = 'iframe[src^="chrome-extension:"], frame[src^="chrome-extension:"], embed[src^="chrome-extension:"], object[data^="chrome-extension:"]';
  for (const el of Array.from(root.querySelectorAll(selector))) {
    const src = (el as HTMLElement).getAttribute('src')
      || (el as HTMLElement).getAttribute('data')
      || '';
    if (src.startsWith(OWN_PREFIX)) continue;
    el.remove();
    removed += 1;
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) removed += stripForeignExtensionEmbeds(shadow);
  }
  return removed;
}

/**
 * Keep stripping embeds as shopping/password extensions re-inject them.
 */
function watchForeignEmbeds(): void {
  stripForeignExtensionEmbeds();
  const obs = new MutationObserver(() => {
    stripForeignExtensionEmbeds();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

/**
 * Evaluate page JS with Runtime.evaluate-like completion semantics.
 * @param code - Source string (may be multi-statement; last value awaited)
 */
async function evalInIsolated(code: string): Promise<unknown> {
  // eslint-disable-next-line no-eval
  const value = (0, eval)(code);
  return await value;
}

watchForeignEmbeds();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'opencli:strip-frames') {
    const removed = stripForeignExtensionEmbeds();
    sendResponse({ ok: true, removed });
    return false;
  }

  if (message.type === 'opencli:eval' && typeof message.code === 'string') {
    void evalInIsolated(message.code)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error });
      });
    return true;
  }

  return false;
});
