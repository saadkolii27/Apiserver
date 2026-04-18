import { Router, type IRouter } from "express";
import { db, monitorsTable, snapshotsTable, usersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { CreateMonitorBody, UpdateMonitorBody, GetMonitorParams, UpdateMonitorParams, DeleteMonitorParams, TriggerCheckParams } from "@workspace/api-zod";
import { checkMonitor, computeNextRunAt } from "../lib/checker";
import { emitToUser } from "../lib/socket";
import { getPlanLimits } from "../lib/plans";
import fs from "fs";
import path from "path";

const router: IRouter = Router();

const getUserId = (req: Express.Request): number => (req as typeof req & { userId: number }).userId;

router.get("/monitors", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const monitors = await db.select().from(monitorsTable)
    .where(eq(monitorsTable.userId, userId))
    .orderBy(desc(monitorsTable.createdAt));
  res.json(monitors.map(serializeMonitor));
});

router.post("/monitors", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = CreateMonitorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const limits = getPlanLimits(user.plan);

  const existingMonitors = await db.select({ id: monitorsTable.id })
    .from(monitorsTable)
    .where(eq(monitorsTable.userId, userId));

  if (limits.maxMonitors !== Infinity && existingMonitors.length >= limits.maxMonitors) {
    res.status(403).json({
      error: `Your ${user.plan} plan allows up to ${limits.maxMonitors} monitors. Upgrade to Pro for unlimited monitors.`,
      code: "PLAN_LIMIT_REACHED",
    });
    return;
  }

  if (!limits.allowedFrequencies.includes(parsed.data.checkFrequency)) {
    res.status(403).json({
      error: `Check frequency "${parsed.data.checkFrequency}" is not available on your ${user.plan} plan. Upgrade to Pro for faster intervals.`,
      code: "PLAN_FREQUENCY_RESTRICTED",
    });
    return;
  }

  if (
    (parsed.data.monitorType === "visual" || parsed.data.monitorType === "both") &&
    !limits.features.visualDiff
  ) {
    res.status(403).json({
      error: "Visual monitoring is only available on the Pro plan.",
      code: "PLAN_FEATURE_RESTRICTED",
    });
    return;
  }

  const actions = (req.body.actions as unknown[]) ?? [];
  const nextRunAt = computeNextRunAt(parsed.data.checkFrequency);

  const [monitor] = await db.insert(monitorsTable).values({
    userId,
    ...parsed.data,
    cssSelector: parsed.data.cssSelector ?? null,
    actions,
    nextRunAt,
  }).returning();

  const serialized = serializeMonitor(monitor);
  emitToUser(userId, "monitor:created", serialized);
  res.status(201).json(serialized);
});

router.get("/monitors/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetMonitorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [monitor] = await db.select().from(monitorsTable)
    .where(and(eq(monitorsTable.id, params.data.id), eq(monitorsTable.userId, userId)));

  if (!monitor) {
    res.status(404).json({ error: "Monitor not found" });
    return;
  }

  res.json(serializeMonitor(monitor));
});

router.patch("/monitors/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = UpdateMonitorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateMonitorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (user) {
    const limits = getPlanLimits(user.plan);
    if (parsed.data.checkFrequency && !limits.allowedFrequencies.includes(parsed.data.checkFrequency)) {
      res.status(403).json({
        error: `Check frequency "${parsed.data.checkFrequency}" is not available on your ${user.plan} plan.`,
        code: "PLAN_FREQUENCY_RESTRICTED",
      });
      return;
    }
    if (
      parsed.data.monitorType &&
      (parsed.data.monitorType === "visual" || parsed.data.monitorType === "both") &&
      !limits.features.visualDiff
    ) {
      res.status(403).json({
        error: "Visual monitoring is only available on the Pro plan.",
        code: "PLAN_FEATURE_RESTRICTED",
      });
      return;
    }
  }

  const updatePayload: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
  if (req.body.actions !== undefined) {
    updatePayload.actions = req.body.actions;
  }

  const [monitor] = await db.update(monitorsTable)
    .set(updatePayload)
    .where(and(eq(monitorsTable.id, params.data.id), eq(monitorsTable.userId, userId)))
    .returning();

  if (!monitor) {
    res.status(404).json({ error: "Monitor not found" });
    return;
  }

  const serializedPatch = serializeMonitor(monitor);
  emitToUser(userId, "monitor:updated", serializedPatch);
  res.json(serializedPatch);
});

router.delete("/monitors/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = DeleteMonitorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [owned] = await db.select({ id: monitorsTable.id }).from(monitorsTable)
    .where(and(eq(monitorsTable.id, params.data.id), eq(monitorsTable.userId, userId)));
  if (!owned) {
    res.status(404).json({ error: "Monitor not found" });
    return;
  }

  const snaps = await db.select({
    screenshotPath: snapshotsTable.screenshotPath,
    diffImagePath: snapshotsTable.diffImagePath,
  }).from(snapshotsTable).where(eq(snapshotsTable.monitorId, owned.id));

  await db.delete(snapshotsTable).where(eq(snapshotsTable.monitorId, owned.id));
  const [monitor] = await db.delete(monitorsTable)
    .where(and(eq(monitorsTable.id, owned.id), eq(monitorsTable.userId, userId)))
    .returning();

  for (const s of snaps) {
    for (const rel of [s.screenshotPath, s.diffImagePath]) {
      if (!rel) continue;
      const fname = path.basename(rel);
      const abs = path.join(process.cwd(), "screenshots", fname);
      fs.promises.unlink(abs).catch(() => {});
    }
  }

  emitToUser(userId, "monitor:deleted", { monitorId: monitor.id });
  res.sendStatus(204);
});

router.post("/monitors/:id/duplicate", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetMonitorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [source] = await db.select().from(monitorsTable)
    .where(and(eq(monitorsTable.id, params.data.id), eq(monitorsTable.userId, userId)));
  if (!source) {
    res.status(404).json({ error: "Monitor not found" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const limits = getPlanLimits(user.plan);
  const existingMonitors = await db.select({ id: monitorsTable.id })
    .from(monitorsTable)
    .where(eq(monitorsTable.userId, userId));

  if (limits.maxMonitors !== Infinity && existingMonitors.length >= limits.maxMonitors) {
    res.status(403).json({
      error: `Your ${user.plan} plan allows up to ${limits.maxMonitors} monitors. Upgrade to Pro for more.`,
      code: "PLAN_LIMIT_REACHED",
    });
    return;
  }

  if (!limits.allowedFrequencies.includes(source.checkFrequency)) {
    res.status(403).json({
      error: `Check frequency "${source.checkFrequency}" is not available on your ${user.plan} plan. Upgrade to Pro to duplicate this monitor.`,
      code: "PLAN_FREQUENCY_RESTRICTED",
    });
    return;
  }

  if (
    (source.monitorType === "visual" || source.monitorType === "both") &&
    !limits.features.visualDiff
  ) {
    res.status(403).json({
      error: "Visual monitoring is only available on the Pro plan.",
      code: "PLAN_FEATURE_RESTRICTED",
    });
    return;
  }

  // Generate a unique "Copy of" name (Copy of X, Copy of X (2), Copy of X (3)...)
  const baseName = `Copy of ${source.name}`;
  const existingNames = new Set(
    (await db.select({ name: monitorsTable.name }).from(monitorsTable)
      .where(eq(monitorsTable.userId, userId))).map((r) => r.name)
  );
  let newName = baseName;
  let suffix = 2;
  while (existingNames.has(newName)) {
    newName = `${baseName} (${suffix++})`;
  }

  const nextRunAt = computeNextRunAt(source.checkFrequency);

  const [duplicate] = await db.insert(monitorsTable).values({
    userId,
    name: newName,
    url: source.url,
    monitorType: source.monitorType,
    cssSelector: source.cssSelector ?? null,
    checkFrequency: source.checkFrequency,
    isActive: source.isActive,
    sensitivityThreshold: source.sensitivityThreshold ?? 1.0,
    actions: (source.actions ?? []) as never,
    nextRunAt,
    // status, lastCheckedAt, lastChangedAt, changeCount intentionally reset to defaults
  }).returning();

  const serialized = serializeMonitor(duplicate);
  emitToUser(userId, "monitor:created", serialized);
  res.status(201).json(serialized);
});

router.post("/monitors/:id/check", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = TriggerCheckParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [monitor] = await db.select().from(monitorsTable)
    .where(and(eq(monitorsTable.id, params.data.id), eq(monitorsTable.userId, userId)));

  if (!monitor) {
    res.status(404).json({ error: "Monitor not found" });
    return;
  }

  const result = await checkMonitor(params.data.id, 1, true);
  res.json(result);
});

// Serve screenshots — require auth and verify the requesting user owns
// a snapshot that references this file (prevents IDOR across users).
router.get("/screenshots/:filename", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const rawFilename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  const filename = path.basename(rawFilename || "");
  if (!filename || !/^[\w.\-]+\.(png|jpg|jpeg|webp)$/i.test(filename)) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }

  const screenshotsDir = path.join(process.cwd(), "screenshots");
  const filePath = path.join(screenshotsDir, filename);
  if (!filePath.startsWith(screenshotsDir + path.sep) || !fs.existsSync(filePath)) {
    res.status(404).json({ error: "Screenshot not found" });
    return;
  }

  const relPath = `/screenshots/${filename}`;
  const [byScreenshot] = await db
    .select({ ok: monitorsTable.id })
    .from(snapshotsTable)
    .innerJoin(monitorsTable, eq(snapshotsTable.monitorId, monitorsTable.id))
    .where(and(
      eq(monitorsTable.userId, userId),
      eq(snapshotsTable.screenshotPath, relPath),
    ))
    .limit(1);

  let owns = !!byScreenshot;
  if (!owns) {
    const [byDiff] = await db
      .select({ ok: monitorsTable.id })
      .from(snapshotsTable)
      .innerJoin(monitorsTable, eq(snapshotsTable.monitorId, monitorsTable.id))
      .where(and(
        eq(monitorsTable.userId, userId),
        eq(snapshotsTable.diffImagePath, relPath),
      ))
      .limit(1);
    owns = !!byDiff;
  }

  if (!owns) {
    res.status(404).json({ error: "Screenshot not found" });
    return;
  }

  res.sendFile(filePath);
});

function serializeMonitor(m: typeof monitorsTable.$inferSelect) {
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

export default router;
