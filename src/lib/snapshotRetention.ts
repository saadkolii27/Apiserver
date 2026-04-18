import fs from "fs";
import path from "path";
import { db, snapshotsTable, usersTable } from "@workspace/db";
import { eq, and, lt, inArray, desc } from "drizzle-orm";
import { getPlanLimits } from "./plans";
import { logger } from "./logger";

const SCREENSHOTS_DIR = path.join(process.cwd(), "screenshots");

function unlinkScreenshot(p: string | null | undefined): void {
  if (!p) return;
  try {
    const abs = path.join(SCREENSHOTS_DIR, path.basename(p));
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (err) {
    logger.warn({ err, path: p }, "Failed to unlink screenshot during prune");
  }
}

/**
 * Delete oldest snapshots for `monitorId` so that at most `limit` remain.
 * Also removes associated screenshot/diff image files from disk.
 * Returns the number of snapshots removed.
 */
export async function pruneSnapshotsForMonitor(
  monitorId: number,
  limit: number,
): Promise<number> {
  if (!Number.isFinite(limit) || limit <= 0) return 0;

  // Get the `limit` most recent snapshot IDs. The cutoff is the smallest of those:
  // anything with id < cutoff is older than the retention window and gets deleted.
  const newest = await db
    .select({ id: snapshotsTable.id })
    .from(snapshotsTable)
    .where(eq(snapshotsTable.monitorId, monitorId))
    .orderBy(desc(snapshotsTable.id))
    .limit(limit);

  if (newest.length < limit) return 0;
  const cutoffId = newest[newest.length - 1]?.id;
  if (cutoffId === undefined) return 0;

  const toDelete = await db
    .select({
      id: snapshotsTable.id,
      screenshotPath: snapshotsTable.screenshotPath,
      diffImagePath: snapshotsTable.diffImagePath,
    })
    .from(snapshotsTable)
    .where(and(eq(snapshotsTable.monitorId, monitorId), lt(snapshotsTable.id, cutoffId)));

  if (toDelete.length === 0) return 0;

  // Delete DB rows FIRST. Only after the rows are gone do we unlink files,
  // so a DB failure can never leave history pointing at missing files.
  await db
    .delete(snapshotsTable)
    .where(inArray(snapshotsTable.id, toDelete.map((r) => r.id)));

  for (const row of toDelete) {
    unlinkScreenshot(row.screenshotPath);
    unlinkScreenshot(row.diffImagePath);
  }

  logger.info(
    { monitorId, removed: toDelete.length, limit },
    "Pruned old snapshots beyond plan retention limit",
  );
  return toDelete.length;
}

/**
 * Look up the user's plan and prune snapshots for the given monitor accordingly.
 * Safe to call after every snapshot insert.
 */
export async function pruneSnapshotsForMonitorByUser(
  monitorId: number,
  userId: number | null | undefined,
): Promise<number> {
  if (!userId) return 0;
  const [user] = await db
    .select({ plan: usersTable.plan })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  const plan = user?.plan ?? "free";
  const limit = getPlanLimits(plan).maxSnapshotsPerMonitor;
  return pruneSnapshotsForMonitor(monitorId, limit);
}
