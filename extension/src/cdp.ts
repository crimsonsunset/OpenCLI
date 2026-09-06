/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission — no host_permissions.
 * It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
 * tabs (resolveTabId in background.ts filters them).
 */

const attached = new Set<number>();
/** Tabs that survived target_closed / attach-poison and must not be reused. */
const poisonedTabs = new Set<number>();

const tabFrameContexts = new Map<number, Map<string, number>>();
// Cross-origin/OOPIF frames are invisible to Page.getFrameTree() and to
// Target.getTargets()/Target.attachToTarget() from a chrome.debugger tab
// session (both reject with "Not allowed" — Target.* is locked down for
// extensions). The only path in is Target.setAutoAttach({flatten:true}) plus
// the resulting Target.attachedToTarget events, which hand back a flat-session
// id usable directly in sendCommand({tabId, sessionId}, ...) (Chrome 125+).
// tabId -> targetId (== frameId for these frame targets) -> flat sessionId.
const frameSessions = new Map<number, Map<string, string>>();
const frameTargetUrls = new Map<string, string>();
const autoAttachRequested = new Set<number>();

// Large cap so agents stop hitting silent JSON.parse failures on real API bodies.
// See src/browser/cdp.ts CDP_RESPONSE_BODY_CAPTURE_LIMIT for the matching constant
// on the direct-CDP path. Keep in sync.
const CDP_RESPONSE_BODY_CAPTURE_LIMIT = 8 * 1024 * 1024;
const CDP_REQUEST_BODY_CAPTURE_LIMIT = 1 * 1024 * 1024;

type NetworkCaptureEntry = {
  kind: 'cdp';
  url: string;
  method: string;
  requestHeaders?: Record<string, string>;
  requestBodyKind?: string;
  requestBodyPreview?: string;
  requestBodyFullSize?: number;
  requestBodyTruncated?: boolean;
  responseStatus?: number;
  responseContentType?: string;
  responseHeaders?: Record<string, string>;
  responsePreview?: string;
  responseBodyFullSize?: number;
  responseBodyTruncated?: boolean;
  timestamp: number;
};

type NetworkCaptureState = {
  patterns: string[];
  entries: NetworkCaptureEntry[];
  requestToIndex: Map<string, number>;
};

export type DownloadWaitResult = {
  downloaded: boolean;
  id?: number;
  filename?: string;
  url?: string;
  finalUrl?: string;
  mime?: string;
  totalBytes?: number;
  state?: string;
  danger?: string;
  error?: string;
  elapsedMs: number;
};

const networkCaptures = new Map<number, NetworkCaptureState>();

/**
 * Default deadline for a single chrome.debugger command. chrome.debugger has
 * no timeout of its own: a page-blocking native dialog (alert/confirm/print/
 * beforeunload) makes Runtime.evaluate hang forever, wedging every later
 * command on the tab. Long enough for legitimate in-page waits (default 30s
 * plus headroom), short enough to fail before the daemon's 120s timer.
 */
const CDP_COMMAND_TIMEOUT_MS = 60_000;
/** Health-check probe deadline — a blocked probe should fail fast. */
const CDP_PROBE_TIMEOUT_MS = 2_000;

/**
 * chrome.debugger.sendCommand with a deadline. The underlying command cannot
 * be cancelled — this only unblocks the caller so the CLI gets an error
 * instead of an infinite hang.
 */
export async function sendDebuggerCommand<T = unknown>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const commandPromise = (params === undefined
    ? chrome.debugger.sendCommand(target, method)
    : chrome.debugger.sendCommand(target, method, params)) as Promise<T>;
  // If the timeout wins the race, the command promise may still reject much
  // later (e.g. debugger detach on tab close) — swallow that on a side branch
  // so it never surfaces as an unhandled rejection in the service worker.
  commandPromise.catch(() => {});
  try {
    return await Promise.race([
      commandPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `CDP command ${method} timed out after ${Math.round(timeoutMs / 1000)}s — the page may be blocked by a native dialog (alert/confirm/print)`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Check if a URL can be attached via CDP — only allow http(s) and blank pages. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}

/**
 * Snapshot debugger targets for attach diagnostics. Foreign chrome-extension://
 * frames on an otherwise-https tab are a known Chrome attach poison
 * (OpenCLI #661/#662). Logged only — does not mutate the page.
 */
async function describeAttachTargets(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const targets = await chrome.debugger.getTargets();
    // Only targets bound to this tabId — global extension service workers are noise.
    const onTab = targets.filter((t) => t.tabId === tabId);
    const foreignExtOnTab = onTab.filter((t) => (
      typeof t.url === 'string'
      && t.url.startsWith('chrome-extension://')
      && !t.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)
    ));
    const pageAttachedElsewhere = onTab.some((t) => t.type === 'page' && t.attached && !attached.has(tabId));
    const summary = {
      tabId,
      tabUrl: tab.url ?? null,
      tabStatus: tab.status ?? null,
      windowId: tab.windowId,
      attachedCache: attached.has(tabId),
      poisoned: poisonedTabs.has(tabId),
      pageAttachedElsewhere,
      onTabCount: onTab.length,
      foreignExtOnTabCount: foreignExtOnTab.length,
      foreignExtOnTab: foreignExtOnTab.slice(0, 20).map((t) => ({
        type: t.type,
        attached: t.attached,
        url: t.url?.slice(0, 180),
      })),
      onTab: onTab.slice(0, 20).map((t) => ({
        type: t.type,
        attached: t.attached,
        url: t.url?.slice(0, 160),
      })),
    };
    return JSON.stringify(summary);
  } catch (err) {
    return JSON.stringify({
      tabId,
      describeError: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Mark a tab as unsafe to reuse for CDP after target_closed / attach poison.
 * @param tabId - Chrome tab id
 * @param reason - Why the tab was poisoned (for logs)
 */
export function markTabPoisoned(tabId: number, reason: string): void {
  poisonedTabs.add(tabId);
  attached.delete(tabId);
  console.warn(`[opencli:attach] poisoned tab=${tabId} reason=${reason}`);
}

/**
 * Wait until a tab's status stays `complete` for quietMs (Amazon /dp fires a
 * second navigation after chrome.tabs reports complete, which kills CDP).
 * @param tabId - Chrome tab id
 * @param quietMs - How long status must remain complete
 * @param maxMs - Overall deadline
 */
export async function waitForTabQuiet(
  tabId: number,
  quietMs: number = 1_200,
  maxMs: number = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  let quietSince: number | null = null;

  while (Date.now() - startedAt < maxMs) {
    let status = 'unknown';
    let url = 'unknown';
    try {
      const tab = await chrome.tabs.get(tabId);
      status = tab.status ?? 'unknown';
      url = tab.url ?? 'unknown';
    } catch {
      console.warn(`[opencli:attach] waitForTabQuiet tab gone tab=${tabId}`);
      return;
    }

    if (status === 'complete') {
      if (quietSince === null) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) {
        console.log(`[opencli:attach] tab quiet tab=${tabId} url=${url} waited=${Date.now() - startedAt}ms`);
        return;
      }
    } else {
      if (quietSince !== null) {
        console.log(`[opencli:attach] quiet broken tab=${tabId} status=${status} url=${url}`);
      }
      quietSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  console.warn(`[opencli:attach] waitForTabQuiet timed out tab=${tabId} after ${maxMs}ms`);
}

/**
 * Whether a tab should be abandoned for a fresh automation tab.
 * @param tabId - Chrome tab id
 */
export function isTabPoisoned(tabId: number): boolean {
  return poisonedTabs.has(tabId);
}

/**
 * Drop poison bookkeeping when a tab is closed/gone.
 * @param tabId - Chrome tab id
 */
export function clearTabPoison(tabId: number): void {
  poisonedTabs.delete(tabId);
}

/**
 * Ensure chrome.debugger is attached to tabId, with optional aggressive retry.
 * @param tabId - Chrome tab id to attach
 * @param aggressiveRetry - Use 5×1500ms instead of 2×500ms
 */
export async function ensureAttached(tabId: number, aggressiveRetry: boolean = false): Promise<void> {
  // Verify the tab URL is debuggable before attempting attach
  try {
    const tab = await chrome.tabs.get(tabId);
    console.log(`[opencli:attach] begin tab=${tabId} aggressive=${aggressiveRetry} url=${tab.url ?? 'unknown'} status=${tab.status ?? '?'} cache=${attached.has(tabId)}`);
    if (!isDebuggableUrl(tab.url)) {
      // Invalidate cache if previously attached
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? 'unknown'}`);
    }
  } catch (e) {
    // Re-throw our own error, catch only chrome.tabs.get failures
    if (e instanceof Error && e.message.startsWith('Cannot debug tab')) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }

  if (attached.has(tabId)) {
    // Verify the debugger is still actually attached by sending a harmless command
    try {
      await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1', returnByValue: true,
      }, CDP_PROBE_TIMEOUT_MS);
      console.log(`[opencli:attach] health-check ok tab=${tabId}`);
      return; // Still attached and working
    } catch (probeErr) {
      // Stale cache entry — need to re-attach
      const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
      console.warn(`[opencli:attach] health-check failed tab=${tabId}: ${probeMsg}`);
      attached.delete(tabId);
    }
  }

  // Retry attach up to 3 times — other extensions (1Password, Playwright MCP Bridge)
  // can temporarily interfere with chrome.debugger. A short delay usually resolves it.
  // Normal commands: 2 retries, 500ms delay (fast fail for non-browser use)
  // Browser commands: 5 retries, 1500ms delay (aggressive, tolerates extension interference)
  const MAX_ATTACH_RETRIES = aggressiveRetry ? 5 : 2;
  const RETRY_DELAY_MS = aggressiveRetry ? 1500 : 500;
  let lastError = '';

  // The forced detach below fires chrome.debugger.onDetach, whose handler wipes
  // this tab's armed network-capture state; detaching also disables the CDP
  // Network domain. Snapshot the capture so we can restore it after a successful
  // re-attach instead of silently dropping in-flight capture — otherwise any
  // non-navigate command that triggers a re-attach (a stale-attach health-check
  // failure during SPA navigation or third-party debugger interference) leaves
  // network-capture-read returning [] even though requests fired.
  const preservedNetworkCapture = networkCaptures.get(tabId);

  for (let attempt = 1; attempt <= MAX_ATTACH_RETRIES; attempt++) {
    try {
      // Force detach first to clear any stale state from other extensions
      try {
        await chrome.debugger.detach({ tabId });
        console.log(`[opencli:attach] pre-detach ok tab=${tabId} attempt=${attempt}`);
      } catch (detachErr) {
        const detachMsg = detachErr instanceof Error ? detachErr.message : String(detachErr);
        console.log(`[opencli:attach] pre-detach noop tab=${tabId} attempt=${attempt}: ${detachMsg}`);
      }
      await chrome.debugger.attach({ tabId }, '1.3');
      console.log(`[opencli:attach] attach ok tab=${tabId} attempt=${attempt}/${MAX_ATTACH_RETRIES}`);
      lastError = '';
      break; // Success
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      const targets = await describeAttachTargets(tabId);
      console.warn(`[opencli:attach] attempt ${attempt}/${MAX_ATTACH_RETRIES} failed: ${lastError} targets=${targets}`);
      // Foreign embeds block attach; strip via content-bridge before burning retries.
      if (lastError.includes('chrome-extension://')) {
        await stripForeignEmbedsViaContent(tabId);
      }
      if (attempt < MAX_ATTACH_RETRIES) {
        // Don't burn 5×1500ms on permanent ghost-attach; fail faster into content-bridge eval.
        const delayMs = lastError.includes('chrome-extension://') && aggressiveRetry
          ? 200
          : RETRY_DELAY_MS;
        const maxAttempts = lastError.includes('chrome-extension://') && aggressiveRetry
          ? Math.min(MAX_ATTACH_RETRIES, 2)
          : MAX_ATTACH_RETRIES;
        if (attempt >= maxAttempts) {
          console.warn(`[opencli:attach] giving up early for content-bridge fallback tab=${tabId}`);
          break;
        }
        console.warn(`[opencli] attach attempt ${attempt}/${MAX_ATTACH_RETRIES} failed: ${lastError}, retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        // Re-verify tab URL before retrying (it may have changed)
        try {
          const tab = await chrome.tabs.get(tabId);
          if (!isDebuggableUrl(tab.url)) {
            lastError = `Tab URL changed to ${tab.url} during retry`;
            break; // Don't retry if URL became un-debuggable
          }
        } catch {
          // Tab is gone — don't fail early here.
          // Later retry layers can re-resolve a fresh automation tab/window.
          lastError = `Tab ${tabId} no longer exists`;
          // Don't break; fall through to retry
        }
      }
    }
  }

  if (lastError) {
    // Log detailed diagnostics for debugging extension conflicts
    let finalUrl = 'unknown';
    let finalWindowId = 'unknown';
    try {
      const tab = await chrome.tabs.get(tabId);
      finalUrl = tab.url ?? 'undefined';
      finalWindowId = String(tab.windowId);
    } catch { /* tab gone */ }
    const targets = await describeAttachTargets(tabId);
    console.error(`[opencli:attach] FAILED tab=${tabId} url=${finalUrl} windowId=${finalWindowId} error=${lastError} targets=${targets}`);
    // Aggressive callers (Amazon) still have content-bridge eval fallback — don't
    // poison yet or resolveTab will replace the tab before that path runs.
    if (!aggressiveRetry && (lastError.includes('chrome-extension://') || lastError.includes('Another debugger is already attached'))) {
      markTabPoisoned(tabId, `attach-failed:${lastError.slice(0, 80)}`);
    }

    const hint = lastError.includes('chrome-extension://')
      ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
      : '';
    throw new Error(`attach failed: ${lastError} (tab=${tabId} url=${finalUrl} windowId=${finalWindowId})${hint}`);
  }
  attached.add(tabId);
  poisonedTabs.delete(tabId);

  try {
    console.log(`[opencli:attach] Runtime.enable begin tab=${tabId}`);
    await sendDebuggerCommand({ tabId }, 'Runtime.enable');
    console.log(`[opencli:attach] Runtime.enable ok tab=${tabId}`);
  } catch (enableErr) {
    const enableMsg = enableErr instanceof Error ? enableErr.message : String(enableErr);
    console.warn(`[opencli:attach] Runtime.enable failed tab=${tabId}: ${enableMsg}`);
  }

  // Restore network capture that the re-attach (detach + onDetach) tore down.
  // The detach always disables the CDP Network domain, so re-enable it and put
  // the accumulated capture state back unconditionally. Done last (after the
  // awaits above) so it wins over the onDetach handler's delete, which fires
  // while those awaits yield to the event loop.
  if (preservedNetworkCapture) {
    try {
      await sendDebuggerCommand({ tabId }, 'Network.enable');
      networkCaptures.set(tabId, preservedNetworkCapture);
    } catch {
      // Leave capture cleared rather than arm a half-attached Network domain;
      // the next start-capture re-arms cleanly.
    }
  }
}

/**
 * Run one Runtime.evaluate attempt after attach.
 * @param tabId - Chrome tab id
 * @param expression - JS to evaluate
 * @param aggressiveRetry - Attach retry profile
 * @param timeoutMs - CDP deadline
 * @param startedAt - Outer evaluate start time for log offsets
 */
async function evaluateOnce(
  tabId: number,
  expression: string,
  aggressiveRetry: boolean,
  timeoutMs: number,
  startedAt: number,
): Promise<unknown> {
  // Attach ASAP — waiting for "quiet" before attach loses the debugger race to
  // other extensions on Amazon /dp (pageAttachedElsewhere becomes true).
  await ensureAttached(tabId, aggressiveRetry);
  console.log(`[opencli:eval] Runtime.evaluate begin tab=${tabId} codeLen=${expression.length} t+${Date.now() - startedAt}ms`);

  const result = await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs) as {
    result?: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Eval error';
    throw new Error(errMsg);
  }

  console.log(`[opencli:eval] Runtime.evaluate ok tab=${tabId} t+${Date.now() - startedAt}ms`);
  return result.result?.value;
}

/**
 * Ask the content-bridge to strip foreign chrome-extension embeds (#662 style).
 * No `scripting` permission required — content_scripts are always available after reload.
 * @param tabId - Chrome tab id
 */
export async function stripForeignEmbedsViaContent(tabId: number): Promise<number> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'opencli:strip-frames' }) as
      | { ok?: boolean; removed?: number }
      | undefined;
    const removed = response?.removed ?? 0;
    console.log(`[opencli:attach] content strip-frames tab=${tabId} removed=${removed}`);
    return removed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[opencli:attach] content strip-frames unavailable tab=${tabId}: ${msg}`);
    return 0;
  }
}

/**
 * Evaluate via content-bridge (isolated world) when CDP attach is poisoned.
 * @param tabId - Chrome tab id
 * @param expression - JS source CDP would have received
 * @param startedAt - Outer evaluate start time for log offsets
 */
async function evaluateViaContentBridge(
  tabId: number,
  expression: string,
  startedAt: number,
): Promise<unknown> {
  console.warn(`[opencli:eval] content-bridge fallback begin tab=${tabId} codeLen=${expression.length} t+${Date.now() - startedAt}ms`);
  await waitForTabQuiet(tabId, 800, 8_000);
  await stripForeignEmbedsViaContent(tabId);

  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'opencli:eval',
    code: expression,
  }) as { ok?: boolean; value?: unknown; error?: string } | undefined;

  if (!response?.ok) {
    throw new Error(response?.error || 'content-bridge eval failed');
  }
  console.log(`[opencli:eval] content-bridge fallback ok tab=${tabId} t+${Date.now() - startedAt}ms`);
  return response.value;
}

/**
 * Evaluate via chrome.userScripts (USER_SCRIPT world). This is the MV3-legal way
 * to run arbitrary adapter code when chrome.debugger cannot attach — isolated
 * content-script/scripting eval is blocked by extension CSP (no unsafe-eval).
 * @param tabId - Chrome tab id
 * @param expression - JS source CDP would have received
 * @param startedAt - Outer evaluate start time for log offsets
 */
async function evaluateViaUserScripts(
  tabId: number,
  expression: string,
  startedAt: number,
): Promise<unknown> {
  if (!chrome.userScripts?.execute) {
    throw new Error(
      'userScripts.execute unavailable — enable "Allow User Scripts" on the OpenCLI extension details page, then reload',
    );
  }
  console.warn(`[opencli:eval] userScripts fallback begin tab=${tabId} codeLen=${expression.length} t+${Date.now() - startedAt}ms`);
  await waitForTabQuiet(tabId, 400, 4_000);
  await stripForeignEmbedsViaContent(tabId);

  // USER_SCRIPT world is exempt from page CSP; await promise completion values
  // the same way Runtime.evaluate(awaitPromise=true) does.
  const results = await chrome.userScripts.execute({
    target: { tabId },
    world: 'USER_SCRIPT',
    injectImmediately: true,
    js: [{ code: expression }],
  });
  const injection = results?.[0];
  if (injection?.error) {
    throw new Error(String(injection.error));
  }
  console.log(`[opencli:eval] userScripts fallback ok tab=${tabId} t+${Date.now() - startedAt}ms`);
  return injection?.result;
}

/**
 * chrome.scripting path with explicit ok/error envelope so CSP-blocked eval
 * cannot silently return null (which crashed amazon readPageState on .href).
 * @param tabId - Chrome tab id
 * @param expression - JS source
 * @param world - Execution world
 */
async function evaluateViaScriptingWorld(
  tabId: number,
  expression: string,
  world: 'MAIN' | 'ISOLATED',
): Promise<unknown> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    args: [expression],
    func: async (code: string) => {
      try {
        // eslint-disable-next-line no-eval
        const value = await (0, eval)(code);
        return { __opencli: true, ok: true as const, value };
      } catch (err) {
        return {
          __opencli: true,
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
  const wrapped = injection?.result as
    | { __opencli?: boolean; ok?: boolean; value?: unknown; error?: string }
    | undefined;
  if (!wrapped || wrapped.__opencli !== true) {
    throw new Error('scripting fallback returned no result (likely CSP-blocked eval)');
  }
  if (!wrapped.ok) {
    throw new Error(wrapped.error || 'scripting fallback eval failed');
  }
  return wrapped.value;
}

/**
 * Whether an eval failure is safe to replay via non-CDP fallbacks.
 * Only pre-eval attach failures are replay-safe — mid-command Detached /
 * Target closed means the expression may already have run (write hazard).
 * @param message - Error message from evaluateOnce / ensureAttached
 */
function isPreEvalAttachFailure(message: string): boolean {
  return message.includes('attach failed')
    || message.includes('Debugger is not attached');
}

/**
 * Evaluate via scripting MAIN → userScripts → scripting ISOLATED.
 * MAIN matches Runtime.evaluate's page world when CSP allows; USER_SCRIPT is
 * the MV3-legal arbitrary-code path for Amazon /dp; ISOLATED is last resort.
 * @param tabId - Chrome tab id
 * @param expression - JS source CDP would have received
 * @param startedAt - Outer evaluate start time for log offsets
 */
async function evaluateViaFallbacks(
  tabId: number,
  expression: string,
  startedAt: number,
): Promise<unknown> {
  const hasScripting = typeof chrome.scripting?.executeScript === 'function';
  if (hasScripting) {
    try {
      console.warn(`[opencli:eval] scripting MAIN fallback begin tab=${tabId}`);
      await waitForTabQuiet(tabId, 400, 4_000);
      const value = await evaluateViaScriptingWorld(tabId, expression, 'MAIN');
      console.log(`[opencli:eval] scripting MAIN fallback ok tab=${tabId} t+${Date.now() - startedAt}ms`);
      return value;
    } catch (scriptErr) {
      const scriptMsg = scriptErr instanceof Error ? scriptErr.message : String(scriptErr);
      console.warn(`[opencli:eval] scripting MAIN fallback failed tab=${tabId}: ${scriptMsg}`);
    }
  }

  try {
    return await evaluateViaUserScripts(tabId, expression, startedAt);
  } catch (userScriptErr) {
    const userScriptMsg = userScriptErr instanceof Error ? userScriptErr.message : String(userScriptErr);
    console.warn(`[opencli:eval] userScripts fallback failed tab=${tabId}: ${userScriptMsg}`);
  }

  if (hasScripting) {
    try {
      console.warn(`[opencli:eval] scripting ISOLATED fallback begin tab=${tabId}`);
      await waitForTabQuiet(tabId, 400, 4_000);
      const value = await evaluateViaScriptingWorld(tabId, expression, 'ISOLATED');
      console.log(`[opencli:eval] scripting ISOLATED fallback ok tab=${tabId} t+${Date.now() - startedAt}ms`);
      return value;
    } catch (scriptErr) {
      const scriptMsg = scriptErr instanceof Error ? scriptErr.message : String(scriptErr);
      console.warn(`[opencli:eval] scripting ISOLATED fallback failed tab=${tabId}: ${scriptMsg}`);
    }
  }

  throw new Error('all non-CDP eval fallbacks failed');
}

export async function evaluate(
  tabId: number,
  expression: string,
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  // Aggressive profile (Amazon / browser): CDP often cannot attach after /dp
  // secondary nav. Replay only for pre-eval attach failures — never for
  // mid-command Detached/Target closed (expression may already have applied).
  const startedAt = Date.now();
  try {
    return await evaluateOnce(tabId, expression, aggressiveRetry, timeoutMs, startedAt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[opencli:eval] failed tab=${tabId} t+${Date.now() - startedAt}ms: ${msg}`);
    const isDetach = msg.includes('Detached')
      || msg.includes('Debugger is not attached')
      || msg.includes('Target closed')
      || msg.includes('attach failed');
    if (!isDetach) throw e;

    attached.delete(tabId);
    if (!aggressiveRetry || !isPreEvalAttachFailure(msg)) {
      markTabPoisoned(tabId, `eval:${msg.slice(0, 80)}`);
      throw e;
    }

    try {
      return await evaluateViaFallbacks(tabId, expression, startedAt);
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      console.warn(`[opencli:eval] fallbacks exhausted tab=${tabId}: ${fallbackMsg}`);
      markTabPoisoned(tabId, `eval:${msg.slice(0, 80)}`);
      throw e;
    }
  }
}

export const evaluateAsync = evaluate;

/**
 * Capture a screenshot via CDP Page.captureScreenshot.
 * Returns base64-encoded image data.
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number } = {},
): Promise<string> {
  await ensureAttached(tabId);

  const format = options.format ?? 'png';
  const fullPage = options.fullPage === true;
  const overrideWidth = options.width && options.width > 0 ? Math.ceil(options.width) : undefined;
  // height is ignored under fullPage so the existing measure-from-content path stays unchanged for users who pass --height alongside --full-page.
  const overrideHeight = !fullPage && options.height && options.height > 0 ? Math.ceil(options.height) : undefined;
  const needsOverride = fullPage || overrideWidth !== undefined || overrideHeight !== undefined;

  if (needsOverride) {
    // When width is set, apply it first so layout reflows before we read content size.
    if (overrideWidth !== undefined && fullPage) {
      await sendDebuggerCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width: overrideWidth,
        height: 0,
        deviceScaleFactor: 1,
      });
    }
    let finalWidth = overrideWidth ?? 0;
    let finalHeight = overrideHeight ?? 0;
    if (fullPage) {
      const metrics = await sendDebuggerCommand({ tabId }, 'Page.getLayoutMetrics') as {
        contentSize?: { width: number; height: number };
        cssContentSize?: { width: number; height: number };
      };
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) {
        if (finalWidth === 0) finalWidth = Math.ceil(size.width);
        finalHeight = Math.ceil(size.height);
      }
    }
    await sendDebuggerCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor: 1,
    });
  }

  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }

    const result = await sendDebuggerCommand({ tabId }, 'Page.captureScreenshot', params) as {
      data: string; // base64-encoded
    };

    return result.data;
  } finally {
    if (needsOverride) {
      await sendDebuggerCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }
}

/**
 * Set local file paths on a file input element via CDP DOM.setFileInputFiles.
 * This bypasses the need to send large base64 payloads through the message channel —
 * Chrome reads the files directly from the local filesystem.
 *
 * @param tabId - Target tab ID
 * @param files - Array of absolute local file paths
 * @param selector - CSS selector to find the file input (optional, defaults to first file input)
 */
export async function setFileInputFiles(
  tabId: number,
  files: string[],
  selector?: string,
): Promise<void> {
  await ensureAttached(tabId);

  // Enable DOM + Page domains. Page is needed for file-chooser interception.
  await sendDebuggerCommand({ tabId }, 'DOM.enable');
  await sendDebuggerCommand({ tabId }, 'Page.enable');

  // Find the file input element (used to trigger the chooser).
  const query = selector || 'input[type="file"]';
  const found = await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
    expression: `!!document.querySelector(${JSON.stringify(query)})`,
    returnByValue: true,
  }) as { result?: { value?: boolean } };
  if (!found.result?.value) {
    throw new Error(`No element found matching selector: ${query}`);
  }

  // Chrome rejects DOM.setFileInputFiles with a plain nodeId/backendNodeId when
  // the debugger is attached via chrome.debugger (crbug 928255, "-32000 Not
  // allowed"). The only accepted path is file-chooser interception: enable it,
  // programmatically open the chooser, and use the backendNodeId that the
  // intercepted Page.fileChooserOpened event hands back. See issue #2108.
  await sendDebuggerCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    const backendNodeId = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Page.fileChooserOpened not received within 5s — the input may not have opened a file chooser'));
      }, 5000);
      const listener = (source: chrome.debugger.Debuggee, method: string, params: unknown) => {
        if (source.tabId !== tabId || method !== 'Page.fileChooserOpened') return;
        // This is our chooser event — settle now either way, so a malformed
        // event rejects immediately instead of hanging until the 5s timeout.
        cleanup();
        const backend = (params as { backendNodeId?: number })?.backendNodeId;
        if (typeof backend === 'number') resolve(backend);
        else reject(new Error('Page.fileChooserOpened carried no backendNodeId'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
      };
      chrome.debugger.onEvent.addListener(listener);
      // Open the chooser programmatically — interception suppresses the native
      // dialog and fires Page.fileChooserOpened instead. Works for hidden inputs.
      void sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(query)}).click()`,
      }).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    // backendNodeId from the intercepted chooser IS accepted by Chrome.
    await sendDebuggerCommand({ tabId }, 'DOM.setFileInputFiles', {
      files,
      backendNodeId,
    });
  } finally {
    await sendDebuggerCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
}

function matchesDownloadPattern(item: chrome.downloads.DownloadItem, pattern: string): boolean {
  if (!pattern) return true;
  const haystack = [
    item.filename,
    item.url,
    item.finalUrl,
    item.mime,
  ].filter(Boolean).join('\n').toLowerCase();
  return haystack.includes(pattern.toLowerCase());
}

function downloadResult(item: chrome.downloads.DownloadItem, startedAt: number): DownloadWaitResult {
  return {
    downloaded: item.state === 'complete',
    id: item.id,
    filename: item.filename,
    url: item.url,
    finalUrl: item.finalUrl,
    mime: item.mime,
    totalBytes: item.totalBytes,
    state: item.state,
    danger: item.danger,
    error: item.error,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function waitForDownload(pattern: string = '', timeoutMs: number = 30000): Promise<DownloadWaitResult> {
  const startedAt = Date.now();
  const timeout = Math.max(1, timeoutMs);

  return await new Promise<DownloadWaitResult>((resolve) => {
    let done = false;
    const inProgressIds = new Set<number>();
    const finish = (result: DownloadWaitResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(result);
    };

    const inspectById = async (id: number) => {
      const items = await chrome.downloads.search({ id });
      const item = items[0];
      if (!item || !matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(id);
      if (item.state === 'complete' || item.state === 'interrupted') finish(downloadResult(item, startedAt));
    };

    const onCreated = (item: chrome.downloads.DownloadItem) => {
      if (!matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(item.id);
      if (item.state === 'complete' || item.state === 'interrupted') finish(downloadResult(item, startedAt));
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (!delta.id) return;
      if (!inProgressIds.has(delta.id) && !delta.filename && !delta.url) return;
      if (delta.filename?.current || delta.url?.current) {
        void inspectById(delta.id);
        return;
      }
      if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
        void inspectById(delta.id);
      }
    };
    const timer = setTimeout(() => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: `No download matched "${pattern || '*'}" within ${timeout}ms`,
        elapsedMs: Date.now() - startedAt,
      });
    }, timeout);

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);

    void chrome.downloads.search({
      limit: 50,
      orderBy: ['-startTime'],
      startedAfter: new Date(startedAt - Math.max(timeout, 1000)).toISOString(),
    }).then((recent) => {
      if (done) return;
      const completed = recent.find((item) => item.state === 'complete' && matchesDownloadPattern(item, pattern));
      if (completed) {
        finish(downloadResult(completed, startedAt));
        return;
      }
      for (const item of recent) {
        if (item.state === 'in_progress' && matchesDownloadPattern(item, pattern)) inProgressIds.add(item.id);
      }
    }).catch((err) => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Kicks off Target.attachedToTarget delivery for a tab's OOPIFs (idempotent —
 * safe to call on every frame lookup). Chrome then reports both frames that
 * already existed and ones that attach later via the events wired up in
 * registerFrameTracking(), which populate frameSessions/frameTargetUrls.
 */
async function ensureAutoAttach(tabId: number): Promise<void> {
  if (autoAttachRequested.has(tabId)) return;
  autoAttachRequested.add(tabId);
  try {
    await sendDebuggerCommand({ tabId }, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    });
  } catch (err) {
    autoAttachRequested.delete(tabId);
    throw err;
  }
}

/** Cross-origin frame targets discovered so far for a tab, as {frameId, url}. */
export function getKnownFrameTargets(tabId: number): Array<{ frameId: string; url: string }> {
  const sessions = frameSessions.get(tabId);
  if (!sessions) return [];
  return [...sessions.keys()].map((frameId) => ({ frameId, url: frameTargetUrls.get(frameId) ?? '' }));
}

/**
 * Ensures auto-attach is on for a tab and gives Target.attachedToTarget a
 * brief window to fire for frames that already existed before this call.
 */
export async function discoverFrameTargets(tabId: number, timeoutMs: number = 1500): Promise<Array<{ frameId: string; url: string }>> {
  await ensureAttached(tabId);
  await ensureAutoAttach(tabId);
  // Auto-attach cascades one level per round trip (parent attach -> setAutoAttach
  // on the child session -> grandchild attach event), so a nested iframe-in-iframe
  // can still be arriving after the first target shows up. Wait until the count
  // holds steady for two checks in a row, rather than stopping at the first hit.
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    const count = frameSessions.get(tabId)?.size ?? 0;
    if (count > 0 && count === lastCount) {
      stableChecks += 1;
      if (stableChecks >= 2) break;
    } else {
      stableChecks = 0;
    }
    lastCount = count;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return getKnownFrameTargets(tabId);
}

async function resolveFrameSessionId(tabId: number, frameId: string, timeoutMs: number): Promise<string> {
  await ensureAutoAttach(tabId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessionId = frameSessions.get(tabId)?.get(frameId);
    if (sessionId) return sessionId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const known = getKnownFrameTargets(tabId).map((t) => `${t.frameId} ${t.url}`).join('; ');
  throw new Error(`No cross-origin frame target found for frame ${frameId}. Candidates: ${known || 'none'}`);
}

export async function sendCommandInFrameTarget(
  tabId: number,
  frameId: string,
  method: string,
  params: Record<string, unknown> = {},
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
  // Unused since frameId now resolves unambiguously via the attachedToTarget
  // cache — kept so callers passing the CLI's --target-url hint still compile.
  _targetUrl?: string,
): Promise<unknown> {
  await ensureAttached(tabId, aggressiveRetry);
  const sessionId = await resolveFrameSessionId(tabId, frameId, timeoutMs);
  const target = { tabId, sessionId } as chrome.debugger.Debuggee;
  return sendDebuggerCommand(target, method, params, timeoutMs);
}

export async function insertText(
  tabId: number,
  text: string,
): Promise<void> {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, 'Input.insertText', { text });
}

export function registerFrameTracking(): void {
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const tabId = source.tabId;
    if (!tabId) return;

    if (method === 'Target.attachedToTarget') {
      const info = params?.targetInfo;
      const sessionId = params?.sessionId;
      if (info?.type === 'iframe' && info.targetId && sessionId) {
        if (!frameSessions.has(tabId)) frameSessions.set(tabId, new Map());
        frameSessions.get(tabId)!.set(info.targetId, sessionId);
        frameTargetUrls.set(info.targetId, info.url ?? '');
        // Auto-attach is not recursive (per Chrome docs) — re-issue it scoped to
        // this child session so a further-nested iframe (iframe-in-iframe) also
        // gets discovered instead of silently stopping one level down.
        sendDebuggerCommand({ tabId, sessionId } as chrome.debugger.Debuggee, 'Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: 'iframe', exclude: false }],
        }).catch(() => {});
      }
      return;
    }

    if (method === 'Target.targetInfoChanged') {
      const info = params?.targetInfo;
      if (info?.type === 'iframe' && info.targetId) frameTargetUrls.set(info.targetId, info.url ?? '');
      return;
    }

    if (method === 'Target.detachedFromTarget') {
      const sessionId = params?.sessionId;
      const sessions = frameSessions.get(tabId);
      if (sessions && sessionId) {
        for (const [frameId, sid] of sessions) {
          if (sid === sessionId) { sessions.delete(frameId); frameTargetUrls.delete(frameId); break; }
        }
      }
      return;
    }

    // Execution context ids are only unique within the session that reported
    // them. With flatten mode, child (OOPIF) session events flow through this
    // same listener tagged with source.sessionId — caching their context ids
    // under the untagged tabId-only key would let evaluateInFrame's fast path
    // reuse a root-session-scoped id number that happens to collide with one
    // from a completely different frame. Only the untagged root session's own
    // contexts belong in this cache; OOPIFs are read via sendCommandInFrameTarget.
    // @types/chrome predates Chrome 125's flat-session addition of sessionId
    // to the onEvent source; it's present on the wire even though the type
    // declares only tabId/extensionId/targetId.
    if ((source as { sessionId?: string }).sessionId) return;

    if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      if (!context?.auxData?.frameId || context.auxData.isDefault !== true) return;
      const frameId = context.auxData.frameId as string;
      if (!tabFrameContexts.has(tabId)) {
        tabFrameContexts.set(tabId, new Map());
      }
      tabFrameContexts.get(tabId)!.set(frameId, context.id);
    }

    if (method === 'Runtime.executionContextDestroyed') {
      const ctxId = params.executionContextId;
      const contexts = tabFrameContexts.get(tabId);
      if (contexts) {
        for (const [fid, cid] of contexts) {
          if (cid === ctxId) { contexts.delete(fid); break; }
        }
      }
    }

    if (method === 'Runtime.executionContextsCleared') {
      tabFrameContexts.delete(tabId);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabFrameContexts.delete(tabId);
  });
}

export async function getFrameTree(tabId: number): Promise<any> {
  await ensureAttached(tabId);
  return sendDebuggerCommand({ tabId }, 'Page.getFrameTree');
}

export async function evaluateInFrame(
  tabId: number,
  expression: string,
  frameId: string,
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  await ensureAttached(tabId, aggressiveRetry);

  await sendDebuggerCommand({ tabId }, 'Runtime.enable').catch(() => {});

  const contexts = tabFrameContexts.get(tabId);
  const contextId = contexts?.get(frameId);

  if (contextId !== undefined) {
    try {
      const result = await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      }, timeoutMs) as {
        result?: { type: string; value?: unknown; description?: string; subtype?: string };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };
      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || 'Eval error';
        throw new Error(errMsg);
      }
      return result.result?.value;
    } catch (err) {
      // A navigated/reloaded frame invalidates its cached context id, but the
      // Runtime.executionContextDestroyed event may not have been processed
      // yet — the cache still holds the stale id and Runtime.evaluate rejects
      // with "Cannot find context with specified id". Drop the stale id and
      // fall through to the frame-target path instead of failing (evaluate()
      // likewise re-resolves on a dead context). Re-throw genuine page errors.
      const msg = String((err as { message?: string })?.message || err);
      if (!/Cannot find context|context with specified id|Execution context was destroyed/i.test(msg)) {
        throw err;
      }
      contexts?.delete(frameId);
    }
  }

  // No cached context, or the cached one went stale: resolve via the frame target.
  await sendCommandInFrameTarget(tabId, frameId, 'Runtime.enable', {}, aggressiveRetry, timeoutMs).catch(() => undefined);
  const result = await sendCommandInFrameTarget(tabId, frameId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, aggressiveRetry, timeoutMs) as {
    result?: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Eval error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

function normalizeCapturePatterns(pattern?: string): string[] {
  return String(pattern || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
}

function shouldCaptureUrl(url: string | undefined, patterns: string[]): boolean {
  if (!url) return false;
  if (!patterns.length) return true;
  return patterns.some((pattern) => url.includes(pattern));
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[String(key)] = String(value);
  }
  return out;
}

function getOrCreateNetworkCaptureEntry(tabId: number, requestId: string, fallback?: {
  url?: string;
  method?: string;
  requestHeaders?: Record<string, string>;
}): NetworkCaptureEntry | null {
  const state = networkCaptures.get(tabId);
  if (!state) return null;
  const existingIndex = state.requestToIndex.get(requestId);
  if (existingIndex !== undefined) {
    return state.entries[existingIndex] || null;
  }
  const url = fallback?.url || '';
  if (!shouldCaptureUrl(url, state.patterns)) return null;
  const entry: NetworkCaptureEntry = {
    kind: 'cdp',
    url,
    method: fallback?.method || 'GET',
    requestHeaders: fallback?.requestHeaders || {},
    timestamp: Date.now(),
  };
  state.entries.push(entry);
  state.requestToIndex.set(requestId, state.entries.length - 1);
  return entry;
}

export async function startNetworkCapture(
  tabId: number,
  pattern?: string,
): Promise<void> {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, 'Network.enable');
  networkCaptures.set(tabId, {
    patterns: normalizeCapturePatterns(pattern),
    entries: [],
    requestToIndex: new Map(),
  });
}

export async function readNetworkCapture(tabId: number): Promise<NetworkCaptureEntry[]> {
  const state = networkCaptures.get(tabId);
  if (!state) return [];
  const entries = state.entries.slice();
  state.entries = [];
  state.requestToIndex.clear();
  return entries;
}

export function hasActiveNetworkCapture(tabId: number): boolean {
  return networkCaptures.has(tabId);
}

function clearFrameTargetsForTab(tabId: number): void {
  const sessions = frameSessions.get(tabId);
  if (sessions) for (const frameId of sessions.keys()) frameTargetUrls.delete(frameId);
  frameSessions.delete(tabId);
  autoAttachRequested.delete(tabId);
}

export async function detach(tabId: number): Promise<void> {
  clearFrameTargetsForTab(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  networkCaptures.delete(tabId);
  tabFrameContexts.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

export function registerListeners(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    networkCaptures.delete(tabId);
    tabFrameContexts.delete(tabId);
    clearFrameTargetsForTab(tabId);
    clearTabPoison(tabId);
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    console.warn(`[opencli:attach] onDetach tabId=${source.tabId ?? 'n/a'} targetId=${source.targetId ?? 'n/a'} reason=${reason ?? 'unknown'}`);
    if (source.tabId) {
      attached.delete(source.tabId);
      networkCaptures.delete(source.tabId);
      tabFrameContexts.delete(source.tabId);
      clearFrameTargetsForTab(source.tabId);
      // canceled_by_user: DevTools stole the debugger — tab is unsafe to reuse.
      // target_closed alone is NOT poison: Amazon /dp fires a secondary navigation
      // after a successful settle eval; mid-command detach still poisons from evaluate().
      if (reason === 'canceled_by_user') {
        markTabPoisoned(source.tabId, `onDetach:${reason}`);
      }
      void describeAttachTargets(source.tabId).then((targets) => {
        console.warn(`[opencli:attach] post-detach targets tab=${source.tabId} ${targets}`);
      });
      return;
    }
  });
  // Invalidate attached cache when tab URL changes to non-debuggable
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await detach(tabId);
    }
  });
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;
    const state = networkCaptures.get(tabId);
    if (!state) return;
    const eventParams = params as Record<string, any> | undefined;

    if (method === 'Network.requestWillBeSent') {
      const requestId = String(eventParams?.requestId || '');
      const request = eventParams?.request as {
        url?: string;
        method?: string;
        headers?: Record<string, unknown>;
        postData?: string;
        hasPostData?: boolean;
      } | undefined;
      const entry = getOrCreateNetworkCaptureEntry(tabId, requestId, {
        url: request?.url,
        method: request?.method,
        requestHeaders: normalizeHeaders(request?.headers),
      });
      if (!entry) return;
      // On an HTTP 30x, CDP re-fires requestWillBeSent with the SAME requestId
      // (the prior hop is carried in `redirectResponse`) for the redirect
      // target — typically a GET with no postData. Overwriting the body here
      // would wipe the original request's captured POST body, so only populate
      // the body on the initial send.
      if (!eventParams?.redirectResponse) {
        entry.requestBodyKind = request?.hasPostData ? 'string' : 'empty';
        {
          const raw = String(request?.postData || '');
          const fullSize = raw.length;
          const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
          entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
          entry.requestBodyFullSize = fullSize;
          entry.requestBodyTruncated = truncated;
        }
        try {
          const postData = await sendDebuggerCommand({ tabId }, 'Network.getRequestPostData', { requestId }) as { postData?: string };
          if (postData?.postData) {
            const raw = postData.postData;
            const fullSize = raw.length;
            const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
            entry.requestBodyKind = 'string';
            entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
            entry.requestBodyFullSize = fullSize;
            entry.requestBodyTruncated = truncated;
          }
        } catch {
          // Optional; some requests do not expose postData.
        }
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const requestId = String(eventParams?.requestId || '');
      const response = eventParams?.response as {
        url?: string;
        mimeType?: string;
        status?: number;
        headers?: Record<string, unknown>;
      } | undefined;
      // Lookup-only (like loadingFinished below): never create an entry from a
      // response. If the matching requestWillBeSent was already drained by a
      // readNetworkCapture() while the request was in flight, creating one here
      // produces an orphan half-entry with a defaulted method ('GET') and no
      // request data.
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      entry.responseStatus = response?.status;
      entry.responseContentType = response?.mimeType || '';
      entry.responseHeaders = normalizeHeaders(response?.headers);
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = String(eventParams?.requestId || '');
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      try {
        const body = await sendDebuggerCommand({ tabId }, 'Network.getResponseBody', { requestId }) as {
          body?: string;
          base64Encoded?: boolean;
        };
        if (typeof body?.body === 'string') {
          const fullSize = body.body.length;
          const truncated = fullSize > CDP_RESPONSE_BODY_CAPTURE_LIMIT;
          const stored = truncated ? body.body.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT) : body.body;
          entry.responsePreview = body.base64Encoded ? `base64:${stored}` : stored;
          entry.responseBodyFullSize = fullSize;
          entry.responseBodyTruncated = truncated;
        }
      } catch {
        // Optional; bodies are unavailable for some requests (e.g. uploads).
      }
    }
  });
}
