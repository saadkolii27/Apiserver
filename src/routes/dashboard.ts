import { Router, type IRouter } from "express";
import { db, monitorsTable, snapshotsTable } from "@workspace/db";
import { eq, and, desc, count, sql, inArray } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { GetRecentChangesQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

const getUserId = (req: Express.Request): number => (req as typeof req & { userId: number }).userId;

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);

  const monitors = await db.select().from(monitorsTable)
    .where(eq(monitorsTable.userId, userId));

  const totalMonitors = monitors.length;
  const activeMonitors = monitors.filter(m => m.isActive).length;
  const totalChangesDetected = monitors.reduce((acc, m) => acc + (m.changeCount ?? 0), 0);
  const monitorsWithChanges = monitors.filter(m => (m.changeCount ?? 0) > 0).length;
  const monitorsWithErrors = monitors.filter(m => m.status === "error").length;
  const lastCheckTimes = monitors
    .map(m => m.lastCheckedAt)
    .filter(Boolean)
    .sort((a, b) => (b?.getTime() ?? 0) - (a?.getTime() ?? 0));
  const lastCheckTime = lastCheckTimes[0]?.toISOString() ?? null;

  res.json({
    totalMonitors,
    activeMonitors,
    totalChangesDetected,
    monitorsWithChanges,
    monitorsWithErrors,
    lastCheckTime,
  });
});

router.get("/dashboard/recent-changes", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const queryParsed = GetRecentChangesQueryParams.safeParse(req.query);
  const limit = queryParsed.success ? (queryParsed.data.limit ?? 10) : 10;

  // Get user's monitors
  const userMonitors = await db.select().from(monitorsTable)
    .where(eq(monitorsTable.userId, userId));
  const monitorIds = userMonitors.map(m => m.id);

  if (monitorIds.length === 0) {
    res.json([]);
    return;
  }

  // Get recent snapshots with changes
  const monitorMap = new Map(userMonitors.map(m => [m.id, m]));

  const recentSnapshots = await db.select().from(snapshotsTable)
    .where(and(
      eq(snapshotsTable.hasChanged, true),
      inArray(snapshotsTable.monitorId, monitorIds),
    ))
    .orderBy(desc(snapshotsTable.createdAt))
    .limit(limit);

  const changes = recentSnapshots
    .map(s => {
      const monitor = monitorMap.get(s.monitorId);
      if (!monitor) return null;
      return {
        monitorId: monitor.id,
        monitorName: monitor.name,
        url: monitor.url,
        monitorType: monitor.monitorType,
        snapshotId: s.id,
        diffScore: s.diffScore ?? null,
        detectedAt: s.createdAt.toISOString(),
      };
    })
    .filter(Boolean);

  res.json(changes);
});

void count;

export default router;
