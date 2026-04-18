import { Router, type IRouter } from "express";
import { db, notificationSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { UpdateNotificationSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

const getUserId = (req: Express.Request): number => (req as typeof req & { userId: number }).userId;

router.get("/notifications", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const [settings] = await db.select().from(notificationSettingsTable)
    .where(eq(notificationSettingsTable.userId, userId));

  if (!settings) {
    // Return defaults
    res.json({
      id: 0,
      userId,
      emailEnabled: false,
      emailAddress: null,
      notifyOnChange: true,
      notifyOnError: true,
    });
    return;
  }

  res.json({
    id: settings.id,
    userId: settings.userId,
    emailEnabled: settings.emailEnabled,
    emailAddress: settings.emailAddress ?? null,
    notifyOnChange: settings.notifyOnChange,
    notifyOnError: settings.notifyOnError,
  });
});

router.put("/notifications", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = UpdateNotificationSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(notificationSettingsTable)
    .where(eq(notificationSettingsTable.userId, userId));

  let settings;
  if (existing) {
    [settings] = await db.update(notificationSettingsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(notificationSettingsTable.userId, userId))
      .returning();
  } else {
    [settings] = await db.insert(notificationSettingsTable)
      .values({ userId, ...parsed.data })
      .returning();
  }

  res.json({
    id: settings.id,
    userId: settings.userId,
    emailEnabled: settings.emailEnabled,
    emailAddress: settings.emailAddress ?? null,
    notifyOnChange: settings.notifyOnChange,
    notifyOnError: settings.notifyOnError,
  });
});

export default router;
