import { logger } from "./logger";
import { assertSafeUrl } from "./urlSafety";

const DEFAULT_TIMEOUT_MS = 12000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface HttpScrapeResult {
  html: string;
  statusCode: number;
  headers: Record<string, string>;
  durationMs: number;
}

export async function httpScrape(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpScrapeResult> {
  await assertSafeUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });

    const html = await res.text();
    const durationMs = Date.now() - start;

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return { html, statusCode: res.status, headers, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    if ((err as Error).name === "AbortError") {
      logger.warn({ url, durationMs }, "HTTP scrape timed out");
      throw new Error(`HTTP scrape timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function needsBrowser(monitor: {
  monitorType: string;
  actions?: unknown[];
  cssSelector?: string | null;
}): boolean {
  if (monitor.monitorType === "visual" || monitor.monitorType === "both") {
    return true;
  }

  if (monitor.actions && Array.isArray(monitor.actions) && monitor.actions.length > 0) {
    return true;
  }

  return false;
}

export function looksLikeJsRendered(html: string): boolean {
  const trimmed = html.trim();

  if (trimmed.length < 500) return true;

  const bodyMatch = trimmed.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    const bodyContent = bodyMatch[1]
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<link[^>]*>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (bodyContent.length < 100) return true;
  }

  const scriptCount = (trimmed.match(/<script[\s\S]*?<\/script>/gi) || []).length;
  const totalLength = trimmed.length;
  const nonScriptLength = trimmed.replace(/<script[\s\S]*?<\/script>/gi, "").length;

  if (scriptCount > 3 && nonScriptLength / totalLength < 0.3) return true;

  const spaSignals = [
    /id=["'](?:root|app|__next|__nuxt|__gatsby)["']/i,
    /data-reactroot/i,
    /ng-app/i,
    /data-server-rendered/i,
  ];
  const hasSpaSkeleton = spaSignals.some((re) => re.test(trimmed));
  if (hasSpaSkeleton && bodyMatch) {
    const textContent = bodyMatch[1].replace(/<[^>]+>/g, "").trim();
    if (textContent.length < 200) return true;
  }

  return false;
}
