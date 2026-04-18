import { Router, type IRouter } from "express";
import { db, monitorsTable, snapshotsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { ListSnapshotsParams, ListSnapshotsQueryParams, GetSnapshotDiffParams } from "@workspace/api-zod";

const router: IRouter = Router();

const getUserId = (req: Express.Request): number => (req as typeof req & { userId: number }).userId;

router.get("/monitors/:id/snapshots", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = ListSnapshotsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const queryParsed = ListSnapshotsQueryParams.safeParse(req.query);
  const limit = queryParsed.success ? (queryParsed.data.limit ?? 20) : 20;

  // Verify ownership
  const [monitor] = await db.select().from(monitorsTable)
    .where(and(eq(monitorsTable.id, params.data.id), eq(monitorsTable.userId, userId)));
  if (!monitor) {
    res.status(404).json({ error: "Monitor not found" });
    return;
  }

  const snapshots = await db.select().from(snapshotsTable)
    .where(eq(snapshotsTable.monitorId, params.data.id))
    .orderBy(desc(snapshotsTable.createdAt))
    .limit(limit);

  res.json(snapshots.map(s => ({
    id: s.id,
    monitorId: s.monitorId,
    htmlContent: s.htmlContent ?? null,
    screenshotPath: s.screenshotPath ?? null,
    hasChanged: s.hasChanged,
    diffScore: s.diffScore ?? null,
    createdAt: s.createdAt.toISOString(),
  })));
});

router.get("/monitors/:id/snapshots/:snapshotId/diff", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetSnapshotDiffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Verify ownership
  const [monitor] = await db.select().from(monitorsTable)
    .where(and(eq(monitorsTable.id, params.data.id), eq(monitorsTable.userId, userId)));
  if (!monitor) {
    res.status(404).json({ error: "Monitor not found" });
    return;
  }

  const [snapshot] = await db.select().from(snapshotsTable)
    .where(and(eq(snapshotsTable.id, params.data.snapshotId), eq(snapshotsTable.monitorId, params.data.id)));

  if (!snapshot) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }

  // Find previous snapshot
  const [previousSnapshot] = await db.select().from(snapshotsTable)
    .where(eq(snapshotsTable.monitorId, params.data.id))
    .orderBy(desc(snapshotsTable.createdAt))
    .limit(100);

  // Find the one before this snapshot
  const allSnapshots = await db.select().from(snapshotsTable)
    .where(eq(snapshotsTable.monitorId, params.data.id))
    .orderBy(desc(snapshotsTable.createdAt));

  const currentIndex = allSnapshots.findIndex(s => s.id === snapshot.id);
  const previous = currentIndex >= 0 && currentIndex < allSnapshots.length - 1
    ? allSnapshots[currentIndex + 1]
    : null;

  void previousSnapshot;

  res.json({
    snapshotId: snapshot.id,
    previousSnapshotId: previous?.id ?? null,
    htmlDiff: snapshot.htmlDiff ?? null,
    screenshotBefore: previous?.screenshotPath ?? null,
    screenshotAfter: snapshot.screenshotPath ?? null,
    diffImagePath: snapshot.diffImagePath ?? null,
    diffScore: snapshot.diffScore ?? null,
    hasChanged: snapshot.hasChanged,
  });
});

export default router;
