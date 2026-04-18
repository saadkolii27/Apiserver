import puppeteer, { type Browser, type Page, type CDPSession } from "puppeteer";
import { logger } from "./logger";
import { assertSafeUrl } from "./urlSafety";

type SessionMode = "browse" | "select" | "record";

interface BrowserSession {
  browser: Browser;
  page: Page;
  cdp: CDPSession;
  userId: number;
  url: string;
  width: number;
  height: number;
  lastActivity: number;
  streaming: boolean;
  mode: SessionMode;
  onSelector?: (selector: string) => void;
  onAction?: (action: { type: string; selector?: string; value?: string }) => void;
  listenersAttached?: boolean;
}

const sessions = new Map<string, BrowserSession>();

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 1;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 900;

let _chromiumPath: string | undefined;
function getChromiumPath(): string {
  if (_chromiumPath !== undefined) return _chromiumPath;
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    _chromiumPath = execSync("which chromium || which chromium-browser || which google-chrome 2>/dev/null")
      .toString()
      .trim()
      .split("\n")[0] ?? "";
  } catch {
    _chromiumPath = "";
  }
  return _chromiumPath;
}

function sessionId(userId: number, monitorId: string): string {
  return `${userId}:${monitorId}`;
}

function cleanupUserSessions(userId: number, excludeMonitorId?: string): void {
  for (const [key, session] of sessions.entries()) {
    if (session.userId === userId && (!excludeMonitorId || !key.endsWith(`:${excludeMonitorId}`))) {
      destroySession(key).catch(() => {});
    }
  }
}

export async function createSession(
  userId: number,
  monitorId: string,
  url: string,
  onFrame: (data: string) => void,
  options?: {
    mode?: SessionMode;
    onSelector?: (selector: string) => void;
    onAction?: (action: { type: string; selector?: string; value?: string }) => void;
  },
): Promise<{ sessionKey: string; width: number; height: number }> {
  const key = sessionId(userId, monitorId);

  if (sessions.has(key)) {
    await destroySession(key);
  }

  cleanupUserSessions(userId, monitorId);

  await assertSafeUrl(url);

  const chromiumPath = getChromiumPath();
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
  ];

  const browser = await puppeteer.launch({
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    args: launchArgs,
    headless: true,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (err) {
    logger.warn({ err, url }, "Browser session: navigation failed, trying load event");
    try {
      await page.goto(url, { waitUntil: "load", timeout: 15000 });
    } catch {
      // Page may still be partially loaded, continue anyway
    }
  }

  const cdp = await page.createCDPSession();

  const initialMode = options?.mode ?? "browse";

  const session: BrowserSession = {
    browser,
    page,
    cdp,
    userId,
    url,
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    lastActivity: Date.now(),
    streaming: true,
    mode: initialMode,
    onSelector: options?.onSelector,
    onAction: options?.onAction,
  };

  sessions.set(key, session);

  cdp.on("Page.screencastFrame", async (params) => {
    if (!session.streaming) return;
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId });
    } catch {}
    onFrame(params.data);
  });

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: VIEWPORT_WIDTH,
    maxHeight: VIEWPORT_HEIGHT,
    everyNthFrame: 1,
  });

  if (initialMode === "select" || initialMode === "record") {
    await injectHelperScript(session);
  }

  logger.info({ userId, monitorId, url, key, mode: initialMode }, "Browser session created");

  return { sessionKey: key, width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
}

export async function handleMouseEvent(
  key: string,
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel",
  x: number,
  y: number,
  button?: "left" | "right" | "middle",
  deltaX?: number,
  deltaY?: number,
): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;
  session.lastActivity = Date.now();

  // In select mode: never dispatch clicks to the page.
  // Only pass mouse movement (so the hover overlay still works).
  // On mousePressed, capture the selector via page.evaluate instead.
  if (session.mode === "select") {
    if (type === "mouseMoved") {
      try {
        await session.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(x),
          y: Math.round(y),
          button: "none",
        });
      } catch (err) {
        logger.debug({ err, key }, "Select-mode mouse move failed");
      }
    } else if (type === "mousePressed") {
      // Capture the selector without touching the page
      try {
        const selector = await session.page.evaluate(([cx, cy]: [number, number]) => {
          const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
          if (!el) return null;
          const fn = (window as any).__wm_getSelector;
          return fn ? fn(el) : null;
        }, [Math.round(x), Math.round(y)] as [number, number]);

        if (selector && session.onSelector) {
          session.onSelector(selector);
        }
      } catch (err) {
        logger.debug({ err, key }, "Selector capture via evaluate failed");
      }
    } else if (type === "mouseWheel") {
      // Allow scrolling in select mode so the user can navigate the page
      try {
        await session.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: Math.round(x),
          y: Math.round(y),
          deltaX: deltaX ?? 0,
          deltaY: deltaY ?? 0,
        });
      } catch (err) {
        logger.debug({ err, key }, "Select-mode scroll failed");
      }
    }
    // mouseReleased: skip in select mode
    return;
  }

  try {
    if (type === "mouseWheel") {
      await session.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(x),
        y: Math.round(y),
        deltaX: deltaX ?? 0,
        deltaY: deltaY ?? 0,
      });
    } else {
      await session.cdp.send("Input.dispatchMouseEvent", {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: button ?? "left",
        clickCount: type === "mousePressed" ? 1 : 0,
      });
    }
  } catch (err) {
    logger.debug({ err, key, type }, "Mouse event dispatch failed");
  }
}

export async function handleKeyEvent(
  key: string,
  type: "keyDown" | "keyUp",
  domKey: string,
  code: string,
  text?: string,
  modifiers?: number,
): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;
  session.lastActivity = Date.now();

  try {
    await session.cdp.send("Input.dispatchKeyEvent", {
      type: type === "keyDown" ? "keyDown" : "keyUp",
      key: domKey,
      code,
      text: type === "keyDown" ? (text || "") : undefined,
      modifiers: modifiers ?? 0,
      windowsVirtualKeyCode: getKeyCode(domKey),
      nativeVirtualKeyCode: getKeyCode(domKey),
    });

    if (type === "keyDown" && text && text.length === 1) {
      await session.cdp.send("Input.dispatchKeyEvent", {
        type: "char",
        text,
        key: domKey,
        code,
        modifiers: modifiers ?? 0,
      });
    }
  } catch (err) {
    logger.debug({ err, key, type, domKey }, "Key event dispatch failed");
  }
}

export async function handleScroll(
  key: string,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  return handleMouseEvent(key, "mouseWheel", x, y, undefined, deltaX, deltaY);
}

export async function navigateSession(key: string, url: string): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;
  session.lastActivity = Date.now();

  try {
    await assertSafeUrl(url);
  } catch (err) {
    logger.warn({ err, url }, "Refusing unsafe navigation in browser session");
    return;
  }

  try {
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch {
    // Continue even if navigation times out
  }
}

export async function destroySession(key: string): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;

  session.streaming = false;
  sessions.delete(key);

  try {
    await session.cdp.send("Page.stopScreencast").catch(() => {});
    await session.cdp.detach().catch(() => {});
    await session.browser.close();
  } catch (err) {
    logger.debug({ err, key }, "Error closing browser session");
  }

  logger.info({ key }, "Browser session destroyed");
}

export function getSessionInfo(key: string): BrowserSession | undefined {
  return sessions.get(key);
}

export async function setSessionMode(
  key: string,
  mode: SessionMode,
  callbacks?: {
    onSelector?: (selector: string) => void;
    onAction?: (action: { type: string; selector?: string; value?: string }) => void;
  },
): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;

  session.mode = mode;
  if (callbacks?.onSelector) session.onSelector = callbacks.onSelector;
  if (callbacks?.onAction) session.onAction = callbacks.onAction;

  if (mode === "select" || mode === "record") {
    await injectHelperScript(session);
  }

  try {
    await session.page.evaluate((m: string) => {
      (window as any).__wm_mode = m;
    }, mode);
  } catch {}
}

async function injectHelperScript(session: BrowserSession): Promise<void> {
  const helperJs = `
(function() {
  if (window.__wm_injected) return;
  window.__wm_injected = true;
  window.__wm_mode = '${session.mode}';

  var overlay = document.createElement('div');
  overlay.id = '__wm_overlay';
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;display:none;border:2px solid #6366f1;background:rgba(99,102,241,0.08);border-radius:2px;transition:all 0.08s ease';
  var label = document.createElement('div');
  label.style.cssText = 'position:absolute;top:-22px;left:0;background:#6366f1;color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;white-space:nowrap;font-family:monospace;max-width:400px;overflow:hidden;text-overflow:ellipsis';
  overlay.appendChild(label);
  document.body.appendChild(overlay);

  window.__wm_getSelector = getSelector;
  function getSelector(el) {
    if (!el || el === document.body) return 'body';
    // 1. id — most stable
    if (el.id && /^[a-zA-Z]/.test(el.id)) return '#' + CSS.escape(el.id);
    // 2. data-testid / data-cy / data-id — explicit test selectors
    var dataAttrs = ['data-testid','data-cy','data-id','data-automation-id','data-qa'];
    for (var d = 0; d < dataAttrs.length; d++) {
      var attrVal = el.getAttribute(dataAttrs[d]);
      if (attrVal) return el.tagName.toLowerCase() + '[' + dataAttrs[d] + '="' + attrVal.replace(/"/g,'\\"') + '"]';
    }
    // 3. aria-label
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return el.tagName.toLowerCase() + '[aria-label="' + ariaLabel.replace(/"/g,'\\"') + '"]';
    // 4. name / placeholder for form elements
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.name) return tag + '[name="' + el.name.replace(/"/g,'\\"') + '"]';
      if (el.placeholder) return tag + '[placeholder="' + el.placeholder.replace(/"/g,'\\"') + '"]';
      if (el.type && el.type !== 'text') return tag + '[type="' + el.type + '"]';
    }
    // 5. CSS path
    var path = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      var seg = cur.tagName.toLowerCase();
      if (cur.id && /^[a-zA-Z]/.test(cur.id)) { seg = '#' + CSS.escape(cur.id); path.unshift(seg); break; }
      if (cur.className && typeof cur.className === 'string') {
        var cls = Array.from(cur.classList).filter(function(c){return c && !c.includes(':') && !c.match(/^[0-9]/);}).slice(0,2).map(function(c){return '.' + CSS.escape(c);}).join('');
        if (cls) seg += cls;
      }
      var sib = cur, nth = 1;
      while ((sib = sib.previousElementSibling)) nth++;
      if (nth > 1) seg += ':nth-child(' + nth + ')';
      path.unshift(seg);
      cur = cur.parentElement;
    }
    return path.join(' > ') || el.tagName.toLowerCase();
  }

  document.addEventListener('mousemove', function(e) {
    if (window.__wm_mode !== 'select' && window.__wm_mode !== 'record') {
      overlay.style.display = 'none';
      return;
    }
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || overlay.contains(el)) return;
    var rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    if (window.__wm_mode === 'record') {
      overlay.style.borderColor = '#22c55e';
      overlay.style.background = 'rgba(34,197,94,0.08)';
      label.style.background = '#22c55e';
    } else {
      overlay.style.borderColor = '#6366f1';
      overlay.style.background = 'rgba(99,102,241,0.08)';
      label.style.background = '#6366f1';
    }
    label.textContent = getSelector(el);
  }, true);

  document.addEventListener('click', function(e) {
    if (window.__wm_mode === 'select') {
      e.preventDefault();
      e.stopImmediatePropagation();
      var sel = getSelector(e.target);
      console.log('__WM_SELECT__' + sel);
      return false;
    }
    if (window.__wm_mode === 'record') {
      var el = e.target;
      var tag = el.tagName.toLowerCase();
      var isInput = (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable);
      if (!isInput) {
        var selector = getSelector(el);
        console.log('__WM_ACTION__' + JSON.stringify({type:'click',selector:selector}));
      }
    }
  }, true);

  var typeTimers = {};
  document.addEventListener('input', function(e) {
    if (window.__wm_mode !== 'record') return;
    var el = e.target;
    var tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;
    var selector = getSelector(el);
    clearTimeout(typeTimers[selector]);
    typeTimers[selector] = setTimeout(function() {
      console.log('__WM_ACTION__' + JSON.stringify({type:'type',selector:selector,value:el.value}));
    }, 600);
  }, true);

  document.addEventListener('change', function(e) {
    if (window.__wm_mode !== 'record') return;
    var el = e.target;
    if (el.tagName.toLowerCase() !== 'select') return;
    var selector = getSelector(el);
    console.log('__WM_ACTION__' + JSON.stringify({type:'select',selector:selector,value:el.value}));
  }, true);

  var scrollTimer = null;
  document.addEventListener('scroll', function() {
    if (window.__wm_mode !== 'record') return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function() {
      var y = Math.round(window.scrollY);
      if (y > 50) {
        console.log('__WM_ACTION__' + JSON.stringify({type:'scroll',y:y}));
      }
    }, 600);
  }, true);
})();
  `;

  try {
    await session.page.evaluate(helperJs);
  } catch (err) {
    logger.debug({ err }, "Failed to inject helper script");
  }

  if (!session.listenersAttached) {
    session.listenersAttached = true;

    session.page.on("console", (msg) => {
      const text = msg.text();
      if (text.startsWith("__WM_SELECT__")) {
        const selector = text.slice("__WM_SELECT__".length);
        if (session.onSelector) session.onSelector(selector);
      } else if (text.startsWith("__WM_ACTION__")) {
        try {
          const action = JSON.parse(text.slice("__WM_ACTION__".length));
          if (session.onAction) session.onAction(action);
        } catch {}
      }
    });

    session.page.on("framenavigated", async () => {
      if (session.mode === "select" || session.mode === "record") {
        try {
          await session.page.evaluate(`
            (function() {
              window.__wm_injected = false;
              ${helperJs}
            })();
          `);
        } catch {}
      }
    });
  }
}

type ReplayAction = {
  type: string;
  selector?: string;
  value?: string;
  y?: number;
  duration?: number;
};

export async function replayActionsInSession(
  key: string,
  actions: ReplayAction[],
  onStep: (index: number, status: "start" | "done" | "error", error?: string) => void,
  onDone: () => void,
): Promise<void> {
  const session = sessions.get(key);
  if (!session) {
    onDone();
    return;
  }

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    onStep(i, "start");
    try {
      await executeActionOnPage(session, action);
      onStep(i, "done");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.debug({ err, action, key }, "Replay action failed");
      onStep(i, "error", error);
    }
    await new Promise<void>((r) => setTimeout(r, 350));
  }

  onDone();
}

async function executeActionOnPage(session: BrowserSession, action: ReplayAction): Promise<void> {
  const page = session.page;
  const SELECTOR_TIMEOUT = 6000;

  switch (action.type) {
    case "click":
      await page.waitForSelector(action.selector!, { timeout: SELECTOR_TIMEOUT });
      await page.click(action.selector!);
      await new Promise((r) => setTimeout(r, 500));
      try { await page.waitForNavigation({ timeout: 2000, waitUntil: "domcontentloaded" }); } catch {}
      break;
    case "type":
      await page.waitForSelector(action.selector!, { timeout: SELECTOR_TIMEOUT });
      await page.click(action.selector!);
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
      }, action.selector!);
      await page.type(action.selector!, action.value ?? "", { delay: 40 });
      break;
    case "scroll":
      await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: "smooth" }), action.y ?? 0);
      await new Promise((r) => setTimeout(r, 500));
      break;
    case "wait":
      await new Promise((r) => setTimeout(r, Math.min(action.duration ?? 1000, 10000)));
      break;
    case "select":
      await page.waitForSelector(action.selector!, { timeout: SELECTOR_TIMEOUT });
      await page.select(action.selector!, action.value ?? "");
      await new Promise((r) => setTimeout(r, 300));
      break;
    case "hover":
      await page.waitForSelector(action.selector!, { timeout: SELECTOR_TIMEOUT });
      await page.hover(action.selector!);
      await new Promise((r) => setTimeout(r, 300));
      break;
    default:
      break;
  }
}

export function startSessionCleanup(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions.entries()) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        logger.info({ key }, "Browser session timed out, cleaning up");
        destroySession(key).catch(() => {});
      }
    }
  }, 30000);
}

function getKeyCode(key: string): number {
  const map: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
    Escape: 27, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Delete: 46, a: 65, b: 66, c: 67, d: 68, e: 69, f: 70, g: 71, h: 72,
    i: 73, j: 74, k: 75, l: 76, m: 77, n: 78, o: 79, p: 80, q: 81,
    r: 82, s: 83, t: 84, u: 85, v: 86, w: 87, x: 88, y: 89, z: 90,
    "0": 48, "1": 49, "2": 50, "3": 51, "4": 52, "5": 53, "6": 54, "7": 55, "8": 56, "9": 57,
    F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119,
    F9: 120, F10: 121, F11: 122, F12: 123,
  };
  return map[key] ?? 0;
}
