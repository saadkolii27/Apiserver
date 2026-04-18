import puppeteer from "puppeteer";
import type { Page, Browser } from "puppeteer";
import type { MonitorAction } from "@workspace/db";
import { logger } from "./logger";
import { assertSafeUrl } from "./urlSafety";

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

const BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "font",
  "texttrack",
  "beacon",
  "csp_report",
  "imageset",
]);

const BLOCKED_URL_PATTERNS = [
  "google-analytics.com",
  "googletagmanager.com",
  "facebook.net",
  "doubleclick.net",
  "adservice.google",
  "analytics.",
  "hotjar.com",
  "mixpanel.com",
  "segment.io",
  "amplitude.com",
  "sentry.io",
  "newrelic.com",
  "clarity.ms",
];

export interface BrowserScrapeResult {
  html: string;
  screenshotPath: string | null;
  durationMs: number;
}

export interface BrowserScrapeOptions {
  url: string;
  screenshotPath?: string;
  actions?: MonitorAction[];
  needsScreenshot?: boolean;
  blockResources?: boolean;
  timeoutMs?: number;
}

export async function browserScrape(opts: BrowserScrapeOptions): Promise<BrowserScrapeResult> {
  const {
    url,
    screenshotPath,
    actions = [],
    needsScreenshot = true,
    blockResources = true,
    timeoutMs = 45000,
  } = opts;

  const start = Date.now();
  await assertSafeUrl(url);
  const chromiumPath = getChromiumPath();

  const browser: Browser = await puppeteer.launch({
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--no-first-run",
      "--disable-default-apps",
    ],
    headless: true,
  });

  let html = "";
  let capturedScreenshot: string | null = null;

  try {
    const page: Page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    if (blockResources) {
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const resourceType = req.resourceType();
        const reqUrl = req.url();

        if (!needsScreenshot && BLOCKED_RESOURCE_TYPES.has(resourceType)) {
          req.abort();
          return;
        }

        if (needsScreenshot && (resourceType === "media" || resourceType === "font")) {
          req.abort();
          return;
        }

        if (BLOCKED_URL_PATTERNS.some((p) => reqUrl.includes(p))) {
          req.abort();
          return;
        }

        if (resourceType === "stylesheet" && !needsScreenshot) {
          req.abort();
          return;
        }

        req.continue();
      });
    }

    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: Math.min(timeoutMs, 30000) });
    } catch {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      } catch {
        // continue with partially loaded page
      }
    }

    if (actions.length > 0) {
      await executeActions(page, actions);
      await delay(1000);
    }

    if (needsScreenshot && screenshotPath) {
      await autoScroll(page);
      await delay(300);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      capturedScreenshot = screenshotPath;
    }

    html = await page.content();
  } finally {
    await browser.close();
  }

  return {
    html,
    screenshotPath: capturedScreenshot,
    durationMs: Date.now() - start,
  };
}

async function executeActions(page: Page, actions: MonitorAction[]): Promise<void> {
  for (const action of actions) {
    try {
      switch (action.type) {
        case "click":
          await page.waitForSelector(action.selector, { timeout: 8000 }).catch(() => {});
          await page.click(action.selector);
          await delay(500);
          try { await page.waitForNavigation({ timeout: 3000, waitUntil: "domcontentloaded" }); } catch {}
          break;
        case "type":
          await page.waitForSelector(action.selector, { timeout: 8000 }).catch(() => {});
          await page.click(action.selector);
          await page.type(action.selector, action.value ?? "", { delay: 30 });
          break;
        case "scroll":
          await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: "smooth" }), action.y ?? 0);
          await delay(400);
          break;
        case "wait":
          await delay(Math.min(action.duration ?? 1000, 10000));
          break;
        case "select":
          await page.waitForSelector(action.selector, { timeout: 8000 }).catch(() => {});
          await page.select(action.selector, action.value ?? "");
          await delay(300);
          break;
        case "hover":
          await page.waitForSelector(action.selector, { timeout: 8000 }).catch(() => {});
          await page.hover(action.selector);
          await delay(300);
          break;
      }
    } catch (err) {
      logger.debug({ err, action }, "Action execution failed, continuing");
    }
  }
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(timer);
        window.scrollTo(0, 0);
        resolve();
      }, 5000);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
