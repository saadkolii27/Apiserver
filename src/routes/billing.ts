import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getPlanLimits } from "../lib/plans";
import crypto from "crypto";

const router: IRouter = Router();

const getUserId = (req: Express.Request): number =>
  (req as typeof req & { userId: number }).userId;

router.get("/billing/plan", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const limits = getPlanLimits(user.plan);
  res.json({
    plan: user.plan,
    subscriptionStatus: user.subscriptionStatus,
    paddleSubscriptionId: user.paddleSubscriptionId ?? null,
    limits: {
      maxMonitors: limits.maxMonitors === Infinity ? -1 : limits.maxMonitors,
      maxSnapshotsPerMonitor: limits.maxSnapshotsPerMonitor,
      allowedFrequencies: limits.allowedFrequencies,
      features: limits.features,
    },
  });
});

router.post(
  "/billing/paddle-webhook",
  async (req, res): Promise<void> => {
    const webhookSecret = process.env["PADDLE_WEBHOOK_SECRET"];

    if (!webhookSecret) {
      res.status(500).json({ error: "Webhook secret not configured" });
      return;
    }

    const signature = req.headers["paddle-signature"] as string | undefined;
    if (!signature) {
      res.status(401).json({ error: "Missing signature" });
      return;
    }

    const parts = signature.split(";");
    const tsStr = parts.find((p) => p.startsWith("ts="))?.split("=")[1];
    const h1 = parts.find((p) => p.startsWith("h1="))?.split("=")[1];

    if (!tsStr || !h1) {
      res.status(401).json({ error: "Malformed signature" });
      return;
    }

    const tsAge = Math.abs(Date.now() / 1000 - Number(tsStr));
    if (tsAge > 300) {
      res.status(401).json({ error: "Timestamp too old" });
      return;
    }

    const payload = `${tsStr}:${JSON.stringify(req.body)}`;
    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(payload)
      .digest("hex");

    const expectedBuf = Buffer.from(expected, "hex");
    const receivedBuf = Buffer.from(h1, "hex");
    if (
      expectedBuf.length !== receivedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const event = req.body;
    const eventType = event?.event_type as string | undefined;

    if (!eventType) {
      res.status(400).json({ error: "Missing event_type" });
      return;
    }

    const data = event.data;

    if (
      eventType === "subscription.created" ||
      eventType === "subscription.updated" ||
      eventType === "subscription.activated"
    ) {
      const customerId = data?.customer_id as string | undefined;
      const subscriptionId = data?.id as string | undefined;
      const status = data?.status as string | undefined;

      if (customerId) {
        const [user] = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.paddleCustomerId, customerId));

        if (user) {
          const updates: Record<string, unknown> = {
            paddleSubscriptionId: subscriptionId ?? user.paddleSubscriptionId,
            updatedAt: new Date(),
          };

          if (status === "active" || status === "trialing") {
            updates.plan = "pro";
            updates.subscriptionStatus = "active";
          } else if (status === "past_due") {
            updates.subscriptionStatus = "past_due";
          } else if (status === "paused") {
            updates.subscriptionStatus = "paused";
          }

          await db
            .update(usersTable)
            .set(updates)
            .where(eq(usersTable.id, user.id));
        }
      }
    }

    if (
      eventType === "subscription.canceled" ||
      eventType === "subscription.expired"
    ) {
      const customerId = data?.customer_id as string | undefined;

      if (customerId) {
        const [user] = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.paddleCustomerId, customerId));

        if (user) {
          await db
            .update(usersTable)
            .set({
              plan: "free",
              subscriptionStatus: "canceled",
              updatedAt: new Date(),
            })
            .where(eq(usersTable.id, user.id));
        }
      }
    }

    res.json({ received: true });
  }
);

router.post(
  "/billing/create-checkout",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = getUserId(req);
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    if (user.plan === "pro" && user.subscriptionStatus === "active") {
      res.status(400).json({ error: "Already subscribed to Pro" });
      return;
    }

    const paddleApiKey = process.env["PADDLE_API_KEY"];
    const priceId = process.env["PADDLE_PRO_PRICE_ID"];

    if (!paddleApiKey || !priceId) {
      res.status(500).json({ error: "Billing not configured" });
      return;
    }

    const paddleEnv = process.env["PADDLE_ENVIRONMENT"] || "sandbox";
    const baseUrl =
      paddleEnv === "production"
        ? "https://api.paddle.com"
        : "https://sandbox-api.paddle.com";

    let customerId = user.paddleCustomerId;

    if (!customerId) {
      const customerRes = await fetch(`${baseUrl}/customers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paddleApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: user.email,
          name: user.name,
        }),
      });

      if (!customerRes.ok) {
        res.status(500).json({ error: "Failed to create billing customer" });
        return;
      }

      const customerData = (await customerRes.json()) as {
        data?: { id?: string };
      };
      customerId = customerData?.data?.id ?? null;

      if (!customerId) {
        res.status(500).json({ error: "Failed to retrieve customer ID" });
        return;
      }

      await db
        .update(usersTable)
        .set({ paddleCustomerId: customerId, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));
    }

    res.json({
      priceId,
      customerId,
      environment: paddleEnv,
    });
  }
);

router.post(
  "/billing/cancel",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = getUserId(req);
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    if (!user.paddleSubscriptionId) {
      res.status(400).json({ error: "No active subscription" });
      return;
    }

    const paddleApiKey = process.env["PADDLE_API_KEY"];
    if (!paddleApiKey) {
      res.status(500).json({ error: "Billing not configured" });
      return;
    }

    const paddleEnv = process.env["PADDLE_ENVIRONMENT"] || "sandbox";
    const baseUrl =
      paddleEnv === "production"
        ? "https://api.paddle.com"
        : "https://sandbox-api.paddle.com";

    const cancelRes = await fetch(
      `${baseUrl}/subscriptions/${user.paddleSubscriptionId}/cancel`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paddleApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ effective_from: "next_billing_period" }),
      }
    );

    if (!cancelRes.ok) {
      res.status(500).json({ error: "Failed to cancel subscription" });
      return;
    }

    await db
      .update(usersTable)
      .set({ subscriptionStatus: "canceling", updatedAt: new Date() })
      .where(eq(usersTable.id, userId));

    res.json({ message: "Subscription will cancel at end of billing period" });
  }
);

export default router;
