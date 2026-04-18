import fs from "fs";
import path from "path";
import { db, monitorsTable, snapshotsTable, notificationSettingsTable, usersTable } from "@workspace/db";
import type { MonitorAction } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { logger } from "./logger";
import { sendChangeNotificationEmail } from "./email";
import { emitToUser } from "./socket";
import { httpScrape, needsBrowser, looksLikeJsRendered } from "./httpScraper";
import { browserScrape } from "./browserScraper";
import { pruneSnapshotsForMonitorByUser } from "./snapshotRetention";
import { compareHtml, compareScreenshots } from "./diffEngine";
import { hasContentChanged } from "./contentHash";
import { MonitorQueue, extractDomain, type QueueTask } from "./queue";


const SCREENSHOTS_DIR = path.join(process.cwd(), "screenshots");

const runningMonitors = new Set<number>();

const FREQ_INTERVALS: Record<string, number> = {
  "30s": 30 * 1000,
  "1min": 60 * 1000,
  "5min": 5 * 60 * 1000,
  "15min": 15 * 60 * 1000,
  "30min": 30 * 60 * 1000,
  "hourly": 60 * 60 * 1000,
  "5h": 5 * 60 * 60 * 1000,
  "daily": 24 * 60 * 60 * 1000,
};

export function computeNextRunAt(checkFrequency: string, anchorTime?: Date): Date {
  const ms = FREQ_INTERVALS[checkFrequency] ?? 60 * 60 * 1000;
  const now = Date.now();

  if (!anchorTime) {
    return new Date(now + ms);
  }

  let next = anchorTime.getTime() + ms;
  while (next <= now) {
    next += ms;
  }
  return new Date(next);
}

function ensureScreenshotsDir() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

function extractSelector(html: string, selector: string): string {
  const classMatch = selector.match(/\.([\w-]+)/);
  const idMatch = selector.match(/#([\w-]+)/);
  const tagMatch = selector.match(/^([\w]+)/);

  if (idMatch) {
    const id = idMatch[1];
    const re = new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/`, "i");
    const m = html.match(re);
    if (m) return m[1];
  }
  if (classMatch) {
    const cls = classMatch[1];
    const re = new RegExp(`class=["'][^"']*${cls}[^"']*["'][^>]*>([\\s\\S]*?)<\\/`, "i");
    const m = html.match(re);
    if (m) return m[1];
  }
  if (tagMatch) {
    const tag = tagMatch[1];
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = html.match(re);
    if (m) return m[1];
  }
  return html;
}

interface MonitorTaskData {
  monitorId: number;
  useBrowser: boolean;
}

const monitorQueue = new MonitorQueue<MonitorTaskData>({
  maxConcurrency: 8,
  maxBrowserConcurrency: 2,
  domainRateLimitMs: 2000,
});

monitorQueue.setIsBrowserTask((task) => task.data.useBrowser);
monitorQueue.setDedupeKey((task) => `monitor-${task.data.monitorId}`);
monitorQueue.setExecutor(async (task) => {
  await checkMonitor(task.data.monitorId);
});

export function getQueueStats() {
  return monitorQueue.stats;
}

export function enqueueMonitorCheck(
  monitorId: number,
  url: string,
  useBrowser: boolean,
  priority = 5,
): void {
  monitorQueue.enqueue({
    id: `monitor-${monitorId}-${Date.now()}`,
    domain: extractDomain(url),
    priority,
    data: { monitorId, useBrowser },
    addedAt: Date.now(),
  });
}

async function capturePageData(
  url: string,
  monitorType: string,
  cssSelector?: string | null,
  actions: MonitorAction[] = [],
): Promise<{
  html: string;
  screenshotPath: string | null;
  durationMs: number;
}> {
  ensureScreenshotsDir();
  const timestamp = Date.now();
  const screenshotFile = `screenshot_${timestamp}.png`;
  const screenshotAbsPath = path.join(SCREENSHOTS_DIR, screenshotFile);
  const screenshotRelPath = `/screenshots/${screenshotFile}`;

  const useBrowserMode = needsBrowser({ monitorType, actions, cssSelector });

  if (useBrowserMode) {
    try {
      const result = await browserScrape({
        url,
        screenshotPath: screenshotAbsPath,
        actions,
        needsScreenshot: monitorType === "visual" || monitorType === "both",
        blockResources: true,
        timeoutMs: 45000,
      });

      let html = result.html;
      if (cssSelector && html) {
        html = extractSelector(html, cssSelector);
      }

      return {
        html,
        screenshotPath: result.screenshotPath ? screenshotRelPath : null,
        durationMs: result.durationMs,
      };
    } catch (err) {
      logger.warn({ err, url }, "Browser scrape failed, falling back to HTTP");
    }
  }

  try {
    const result = await httpScrape(url, 12000);
    let html = result.html;

    let totalDurationMs = result.durationMs;

    if (looksLikeJsRendered(html)) {
      logger.info({ url }, "HTTP response looks JS-rendered, escalating to browser");
      try {
        const browserResult = await browserScrape({
          url,
          screenshotPath: screenshotAbsPath,
          actions,
          needsScreenshot: false,
          blockResources: true,
          timeoutMs: 45000,
        });
        html = browserResult.html;
        totalDurationMs += browserResult.durationMs;
      } catch (browserErr) {
        logger.warn({ browserErr, url }, "Browser escalation failed, using HTTP content");
      }
    }

    if (cssSelector && html) {
      html = extractSelector(html, cssSelector);
    }

    return { html, screenshotPath: null, durationMs: totalDurationMs };
  } catch (err) {
    logger.warn({ err, url }, "HTTP scrape also failed");
    return { html: "", screenshotPath: null, durationMs: 0 };
  }
}

async function runCheck(monitorId: number, isManual = false): Promise<{
  hasChanged: boolean;
  message: string;
  snapshotId: number | null;
}> {
  const [monitor] = await db.select().from(monitorsTable).where(eq(monitorsTable.id, monitorId));
  if (!monitor) return { hasChanged: false, message: "Monitor not found", snapshotId: null };

  await db.update(monitorsTable)
    .set({ status: "checking", updatedAt: new Date() })
    .where(eq(monitorsTable.id, monitorId));

  if (monitor.userId) {
    emitToUser(monitor.userId, "monitor:checking", { monitorId });
  }

  const actions = (monitor.actions ?? []) as MonitorAction[];
  const sensitivityPct = monitor.sensitivityThreshold ?? 1.0;

  const { html, screenshotPath, durationMs } = await capturePageData(
    monitor.url,
    monitor.monitorType,
    monitor.cssSelector,
    actions,
  );

  logger.info({ monitorId, url: monitor.url, durationMs, mode: needsBrowser({ monitorType: monitor.monitorType, actions, cssSelector: monitor.cssSelector }) ? "browser" : "http" }, "Page captured");

  const [previousSnapshot] = await db.select()
    .from(snapshotsTable)
    .where(eq(snapshotsTable.monitorId, monitorId))
    .orderBy(desc(snapshotsTable.createdAt))
    .limit(1);

  let hasChanged = false;
  let htmlChanged = false;
  let diffScore: number | null = null;
  let htmlDiff: string | null = null;
  let diffImagePath: string | null = null;

  if (previousSnapshot) {
    if (monitor.monitorType === "html" || monitor.monitorType === "both") {
      const prevHtml = previousSnapshot.htmlContent ?? "";

      const { changed: hashChanged } = hasContentChanged(prevHtml, html);

      if (!hashChanged) {
        logger.debug({ monitorId }, "Content hash unchanged, skipping diff");
      } else {
        const result = compareHtml(prevHtml, html);
        if (result.hasChanged) {
          htmlChanged = true;
          hasChanged = true;
          htmlDiff = result.diff;
        }
      }
    }

    if ((monitor.monitorType === "visual" || monitor.monitorType === "both") && screenshotPath && previousSnapshot.screenshotPath) {
      const result = compareScreenshots(
        previousSnapshot.screenshotPath,
        screenshotPath,
      );
      diffScore = result.diffScore;
      diffImagePath = result.diffImagePath;
      const scorePercent = result.diffScore * 100;
      if (scorePercent >= sensitivityPct) {
        hasChanged = true;
      }
    }
  }

  const [snapshot] = await db.insert(snapshotsTable).values({
    monitorId,
    htmlContent: html || null,
    screenshotPath: screenshotPath || null,
    hasChanged,
    diffScore,
    htmlDiff,
    diffImagePath,
  }).returning();

  // Enforce per-plan snapshot retention limits (deletes oldest beyond cap + frees disk).
  try {
    await pruneSnapshotsForMonitorByUser(monitorId, monitor.userId);
  } catch (err) {
    logger.warn({ err, monitorId }, "Snapshot retention prune failed");
  }

  const updateData: Record<string, unknown> = {
    status: hasChanged ? "changed" : "unchanged",
    lastCheckedAt: new Date(),
    updatedAt: new Date(),
  };
  if (!isManual) {
    const scheduledAt = monitor.nextRunAt ?? monitor.lastCheckedAt ?? new Date();
    updateData.nextRunAt = computeNextRunAt(monitor.checkFrequency, scheduledAt);
  }
  if (hasChanged) {
    updateData.lastChangedAt = new Date();
    updateData.changeCount = (monitor.changeCount ?? 0) + 1;
  }

  await db.update(monitorsTable).set(updateData).where(eq(monitorsTable.id, monitorId));

  if (monitor.userId) {
    const [updatedMonitor] = await db.select().from(monitorsTable).where(eq(monitorsTable.id, monitorId));
    if (updatedMonitor) {
      emitToUser(monitor.userId, "monitor:updated", serializeMonitorForSocket(updatedMonitor));
    }

    emitToUser(monitor.userId, "snapshot:created", {
      monitorId,
      snapshotId: snapshot.id,
      hasChanged,
      diffScore,
      createdAt: snapshot.createdAt?.toISOString() ?? new Date().toISOString(),
    });

    if (hasChanged) {
      emitToUser(monitor.userId, "change:detected", {
        monitorId,
        monitorName: monitor.name,
        url: monitor.url,
        hasChanged,
        diffScore,
        snapshotId: snapshot.id,
        changeCount: (monitor.changeCount ?? 0) + 1,
      });
    }
  }

  if (hasChanged && monitor.userId) {
    await sendNotificationIfEnabled({
      userId: monitor.userId,
      monitorId: monitor.id,
      monitorName: monitor.name,
      url: monitor.url,
      monitorType: monitor.monitorType,
      diffScore,
      htmlDiff,
      previousScreenshotPath: previousSnapshot?.screenshotPath ?? null,
      newScreenshotPath: screenshotPath,
      diffImagePath,
      changeCount: (monitor.changeCount ?? 0) + 1,
      htmlChanged,
      sensitivityPct,
    });
  }

  return {
    hasChanged,
    message: hasChanged ? "Change detected" : previousSnapshot ? "No changes detected" : "Initial snapshot captured",
    snapshotId: snapshot.id,
  };
}

export async function checkMonitor(monitorId: number, maxRetries = 1, isManual = false): Promise<{
  hasChanged: boolean;
  message: string;
  snapshotId: number | null;
}> {
  if (runningMonitors.has(monitorId)) {
    logger.info({ monitorId }, "Monitor check skipped — already running");
    return { hasChanged: false, message: "Check already in progress", snapshotId: null };
  }

  runningMonitors.add(monitorId);

  let lastError: Error | null = null;
  let delayMs = 3000;
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await runCheck(monitorId, isManual);
        return result;
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries) {
          logger.warn({ err, monitorId, attempt, nextDelayMs: delayMs }, "Monitor check failed, retrying with backoff…");
          await new Promise(r => setTimeout(r, delayMs));
          delayMs = Math.min(delayMs * 2, 30000);
        }
      }
    }
  } finally {
    runningMonitors.delete(monitorId);
  }
  logger.error({ err: lastError, monitorId }, "Error checking monitor after retries");

  const [failedMonitor] = await db.select().from(monitorsTable).where(eq(monitorsTable.id, monitorId));
  const errorUpdate: Record<string, unknown> = {
    status: "error",
    lastCheckedAt: new Date(),
    updatedAt: new Date(),
  };
  if (!isManual) {
    errorUpdate.nextRunAt = computeNextRunAt(failedMonitor?.checkFrequency ?? "hourly");
  }
  await db.update(monitorsTable)
    .set(errorUpdate)
    .where(eq(monitorsTable.id, monitorId));

  const [errMonitor] = await db.select().from(monitorsTable).where(eq(monitorsTable.id, monitorId));
  if (errMonitor?.userId) {
    emitToUser(errMonitor.userId, "monitor:updated", serializeMonitorForSocket(errMonitor));
  }

  return { hasChanged: false, message: `Error: ${lastError?.message ?? "Unknown"}`, snapshotId: null };
}

async function sendNotificationIfEnabled(opts: {
  userId: number;
  monitorId: number;
  monitorName: string;
  url: string;
  monitorType: string;
  diffScore: number | null;
  htmlDiff: string | null;
  previousScreenshotPath: string | null;
  newScreenshotPath: string | null;
  diffImagePath: string | null;
  changeCount: number;
  htmlChanged: boolean;
  sensitivityPct: number;
}) {
  const [settings] = await db.select()
    .from(notificationSettingsTable)
    .where(and(
      eq(notificationSettingsTable.userId, opts.userId),
      eq(notificationSettingsTable.emailEnabled, true),
      eq(notificationSettingsTable.notifyOnChange, true),
    ));

  if (!settings?.emailAddress) return;

  if (opts.monitorType === "visual" && opts.diffScore !== null) {
    if (opts.diffScore * 100 < opts.sensitivityPct) return;
  }

  await sendChangeNotificationEmail({
    to: settings.emailAddress,
    monitorName: opts.monitorName,
    url: opts.url,
    monitorType: opts.monitorType,
    diffScore: opts.diffScore,
    checkedAt: new Date(),
    monitorId: opts.monitorId,
    htmlDiff: opts.htmlDiff,
    previousScreenshotPath: opts.previousScreenshotPath,
    newScreenshotPath: opts.newScreenshotPath,
    diffImagePath: opts.diffImagePath,
    changeCount: opts.changeCount,
  });
}

export async function checkAllActiveMonitors(): Promise<void> {
  const monitors = await db.select().from(monitorsTable).where(eq(monitorsTable.isActive, true));
  logger.info({ count: monitors.length, queueStats: monitorQueue.stats }, "Running scheduled check for all active monitors");

  const now = new Date();

  const tasksToEnqueue: QueueTask<MonitorTaskData>[] = [];

  for (const monitor of monitors) {
    if (runningMonitors.has(monitor.id)) continue;

    if (monitor.nextRunAt && monitor.nextRunAt > now) continue;

    if (!monitor.nextRunAt && monitor.lastCheckedAt) {
      const diffMs = now.getTime() - monitor.lastCheckedAt.getTime();
      const minIntervals: Record<string, number> = {
        "30s": 0.5, "1min": 1, "5min": 5, "15min": 15, "30min": 30, "hourly": 60, "5h": 300, "daily": 1440,
      };
      const requiredMin = minIntervals[monitor.checkFrequency] ?? 60;
      if (diffMs / 60000 < requiredMin) continue;
    }

    const actions = (monitor.actions ?? []) as MonitorAction[];
    const useBrowser = needsBrowser({
      monitorType: monitor.monitorType,
      actions,
      cssSelector: monitor.cssSelector,
    });

    const freqPriority: Record<string, number> = {
      "30s": 1, "1min": 2, "5min": 3, "15min": 4, "30min": 5, "hourly": 6, "5h": 7, "daily": 8,
    };

    tasksToEnqueue.push({
      id: `monitor-${monitor.id}-${Date.now()}`,
      domain: extractDomain(monitor.url),
      priority: freqPriority[monitor.checkFrequency] ?? 5,
      data: { monitorId: monitor.id, useBrowser },
      addedAt: Date.now(),
    });
  }

  if (tasksToEnqueue.length > 0) {
    monitorQueue.enqueueBatch(tasksToEnqueue);
    logger.info({ enqueued: tasksToEnqueue.length }, "Monitors enqueued for checking");
  }
}

void usersTable;

function serializeMonitorForSocket(m: typeof monitorsTable.$inferSelect) {
  return {
    id: m.id,
    userId: m.userId,
    name: m.name,
    url: m.url,
    monitorType: m.monitorType,
    cssSelector: m.cssSelector ?? null,
    checkFrequency: m.checkFrequency,
    isActive: m.isActive,
    status: m.status,
    sensitivityThreshold: m.sensitivityThreshold ?? 1.0,
    actions: (m.actions ?? []) as unknown[],
    lastCheckedAt: m.lastCheckedAt?.toISOString() ?? null,
    lastChangedAt: m.lastChangedAt?.toISOString() ?? null,
    nextRunAt: m.nextRunAt?.toISOString() ?? null,
    changeCount: m.changeCount ?? 0,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}
