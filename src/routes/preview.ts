import { Router, type IRouter } from "express";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { requireAuth } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";
import { assertSafeUrl } from "../lib/urlSafety";
import type { MonitorAction } from "@workspace/db";

const execAsync = promisify(exec);
const router: IRouter = Router();

const SCREENSHOTS_DIR = path.join(process.cwd(), "screenshots");

let _chromiumPath: string | undefined;
function getChromiumPath(): string {
  if (_chromiumPath !== undefined) return _chromiumPath;
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    _chromiumPath = execSync("which chromium || which chromium-browser || which google-chrome 2>/dev/null").toString().trim().split("\n")[0] ?? "";
  } catch {
    _chromiumPath = "";
  }
  return _chromiumPath;
}

function ensureScreenshotsDir() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

function buildActionsScript(actions: MonitorAction[]): string {
  return actions.map(action => {
    switch (action.type) {
      case "click":
        return `  try { await page.click(${JSON.stringify(action.selector)}); await new Promise(r => setTimeout(r, 500)); } catch(e) {}`;
      case "type":
        return `  try { await page.click(${JSON.stringify(action.selector)}); await page.type(${JSON.stringify(action.selector)}, ${JSON.stringify(action.value)}); } catch(e) {}`;
      case "scroll":
        return `  await page.evaluate((y) => window.scrollTo(0, y), ${action.y});  await new Promise(r => setTimeout(r, 300));`;
      case "wait":
        return `  await new Promise(r => setTimeout(r, ${Math.min(action.duration, 10000)}));`;
      default:
        return "";
    }
  }).join("\n");
}

router.post("/preview/screenshot", requireAuth, async (req, res): Promise<void> => {
  const { url, actions = [] } = req.body as { url: string; actions?: MonitorAction[] };

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }

  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
    normalizedUrl = "https://" + normalizedUrl;
  }

  try {
    new URL(normalizedUrl);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  try {
    await assertSafeUrl(normalizedUrl);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "URL not allowed" });
    return;
  }

  ensureScreenshotsDir();
  const timestamp = Date.now();
  const screenshotFile = `preview_${timestamp}.png`;
  const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotFile);
  const actionsCode = buildActionsScript(actions);
  const chromiumPath = getChromiumPath();
  const executablePathLine = chromiumPath ? `executablePath: ${JSON.stringify(chromiumPath)},` : "";

  const script = `
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ ${executablePathLine} args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  try {
    await page.goto(${JSON.stringify(normalizedUrl)}, { waitUntil: 'networkidle0', timeout: 30000 });
  } catch(e) {
    await page.goto(${JSON.stringify(normalizedUrl)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
${actionsCode}
${actions.length > 0 ? "  await new Promise(r => setTimeout(r, 1000));" : ""}
  await page.screenshot({ path: ${JSON.stringify(screenshotPath)}, fullPage: false });
  await browser.close();
})().catch(e => { process.stderr.write(e.message); process.exit(1); });
`;

  const tmpScript = path.join("/tmp", `preview_${timestamp}.cjs`);
  fs.writeFileSync(tmpScript, script);

  const nodeModulesPath = path.join(process.cwd(), "node_modules");
  try {
    await execAsync(`node ${tmpScript}`, {
      timeout: 60000,
      env: { ...process.env, NODE_PATH: nodeModulesPath },
    });
    res.json({ screenshotUrl: `/api/screenshots/${screenshotFile}` });
  } catch (err) {
    logger.error({ err, url: normalizedUrl }, "Preview screenshot failed");
    res.status(500).json({ error: "Failed to capture screenshot. Check the URL is accessible." });
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }
});

const SELECTOR_SCRIPT = `
<script>
(function() {
  // Modes: 'select' | 'interact' | 'record'
  var __wm_mode = 'select';
  var overlay = null;
  var label = null;

  function ensureOverlay() {
    if (overlay) return;
    if (!document.body) return;
    overlay = document.createElement('div');
    overlay.id = '__wm_overlay';
    overlay.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #6366f1;background:rgba(99,102,241,0.08);z-index:2147483647;box-sizing:border-box;transition:all 0.08s ease;border-radius:2px;display:none';
    label = document.createElement('div');
    label.style.cssText = 'position:absolute;top:-22px;left:0;background:#6366f1;color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;white-space:nowrap;font-family:monospace;max-width:400px;overflow:hidden;text-overflow:ellipsis';
    overlay.appendChild(label);
    document.body.appendChild(overlay);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureOverlay);
  } else {
    ensureOverlay();
  }

  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'WM_SET_MODE') {
      __wm_mode = e.data.mode || 'interact';
      if (__wm_mode !== 'select' && overlay) {
        overlay.style.display = 'none';
      }
    }
  }, false);

  function getSelector(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    var path = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      var seg = cur.tagName.toLowerCase();
      if (cur.id) { seg = '#' + CSS.escape(cur.id); path.unshift(seg); break; }
      if (cur.className && typeof cur.className === 'string') {
        var cls = Array.from(cur.classList).filter(function(c) { return c && !c.includes(':'); }).slice(0,2).map(function(c) { return '.' + CSS.escape(c); }).join('');
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

  // ---- SELECT + RECORD MODE: highlight overlay on hover ----
  document.addEventListener('mousemove', function(e) {
    if (__wm_mode !== 'select' && __wm_mode !== 'record') return;
    ensureOverlay();
    if (!overlay) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || overlay.contains(el)) return;
    var rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    if (__wm_mode === 'record') {
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

  // ---- Find closest anchor for navigation ----
  function closestAnchor(el) {
    var cur = el;
    while (cur && cur !== document.body) {
      if (cur.tagName && cur.tagName.toLowerCase() === 'a' && cur.href) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  document.addEventListener('click', function(e) {
    if (__wm_mode === 'select') {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      var sel = getSelector(e.target);
      window.parent.postMessage({ type: 'WM_SELECTOR', selector: sel, tagName: e.target.tagName.toLowerCase() }, '*');
      return false;
    }
    if (__wm_mode === 'record') {
      var el = e.target;
      var tag = el.tagName.toLowerCase();
      var isInput = (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable);
      if (!isInput) {
        var selector = getSelector(el);
        window.parent.postMessage({ type: 'WM_ACTION', action: { type: 'click', selector: selector } }, '*');
        showFlash(el);
      }
      var anchor = closestAnchor(el);
      if (anchor && anchor.href) {
        var href = anchor.href;
        try {
          var parsed = new URL(href, window.location.href);
          if (parsed.origin !== window.location.origin || parsed.pathname !== window.location.pathname || parsed.search !== window.location.search) {
            e.preventDefault();
            e.stopPropagation();
            window.parent.postMessage({ type: 'WM_NAVIGATE', url: parsed.href }, '*');
          }
        } catch(ex) {}
      }
    }
  }, true);

  document.addEventListener('mousedown', function(e) {
    if (__wm_mode === 'select') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('mouseup', function(e) {
    if (__wm_mode === 'select') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // ---- RECORD MODE: capture type actions ----
  var __wm_typeTimers = {};

  function onInputChange(e) {
    if (__wm_mode !== 'record') return;
    var el = e.target;
    var tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;
    var selector = getSelector(el);
    var key = selector;
    clearTimeout(__wm_typeTimers[key]);
    __wm_typeTimers[key] = setTimeout(function() {
      window.parent.postMessage({ type: 'WM_ACTION', action: { type: 'type', selector: selector, value: el.value } }, '*');
      showFlash(el);
    }, 600);
  }
  document.addEventListener('input', onInputChange, true);

  function showFlash(el) {
    try {
      var prev = el.style.outline;
      var prevTrans = el.style.transition;
      el.style.transition = 'outline 0.15s ease';
      el.style.outline = '2px solid #22c55e';
      setTimeout(function() {
        el.style.outline = prev;
        el.style.transition = prevTrans;
      }, 400);
    } catch(ex) {}
  }
})();
</script>
`;

router.get("/preview/proxy", requireAuth, async (req, res): Promise<void> => {
  const url = req.query["url"] as string;
  if (!url) {
    res.status(400).send("url query param required");
    return;
  }

  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
    normalizedUrl = "https://" + normalizedUrl;
  }

  try {
    new URL(normalizedUrl);
  } catch {
    res.status(400).send("Invalid URL");
    return;
  }

  try {
    await assertSafeUrl(normalizedUrl);
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : "URL not allowed");
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(normalizedUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timeout);

    if (response.url && response.url !== normalizedUrl) {
      try {
        await assertSafeUrl(response.url);
      } catch (err) {
        logger.warn({ err, finalUrl: response.url }, "Proxy fetch redirected to unsafe URL");
        res.status(400).send("Redirected to a disallowed host");
        return;
      }
    }

    let html = await response.text();
    const base = new URL(normalizedUrl);
    const baseTag = `<base href="${base.origin}${base.pathname}">`;

    // Remove existing base tags and inject ours + selector script
    html = html.replace(/<base[^>]*>/gi, "");
    html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}${SELECTOR_SCRIPT}`);

    // Remove X-Frame-Options and CSP via response headers
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.send(html);
  } catch (err) {
    logger.warn({ err, url: normalizedUrl }, "Proxy fetch failed");
    res.status(502).send(`
      <html><body style="font-family:sans-serif;padding:20px;background:#0f1117;color:#9ca3af">
        <p style="font-size:14px">Could not load this page directly. The site may block embedding.</p>
        <p style="font-size:12px">Use the CSS selector field below to manually enter a selector instead.</p>
      </body></html>
    `);
  }
});

router.get("/preview/live-proxy", requireAuth, async (req, res): Promise<void> => {
  const url = req.query["url"] as string;
  if (!url) {
    res.status(400).send("url query param required");
    return;
  }

  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
    normalizedUrl = "https://" + normalizedUrl;
  }

  try {
    new URL(normalizedUrl);
  } catch {
    res.status(400).send("Invalid URL");
    return;
  }

  try {
    await assertSafeUrl(normalizedUrl);
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : "URL not allowed");
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(normalizedUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timeout);

    if (response.url && response.url !== normalizedUrl) {
      try {
        await assertSafeUrl(response.url);
      } catch (err) {
        logger.warn({ err, finalUrl: response.url }, "Live proxy redirected to unsafe URL");
        res.status(400).send("Redirected to a disallowed host");
        return;
      }
    }

    let html = await response.text();
    const base = new URL(normalizedUrl);
    const baseTag = `<base href="${base.origin}${base.pathname}">`;

    html = html.replace(/<base[^>]*>/gi, "");
    html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.send(html);
  } catch (err) {
    logger.warn({ err, url: normalizedUrl }, "Live proxy fetch failed");
    res.status(502).send(`
      <html><body style="font-family:system-ui,sans-serif;padding:40px;background:#0f1117;color:#9ca3af;text-align:center">
        <p style="font-size:16px;color:#e5e7eb;margin-bottom:8px">Unable to load this website</p>
        <p style="font-size:13px">The site may block embedding or is unreachable.</p>
      </body></html>
    `);
  }
});

export default router;
