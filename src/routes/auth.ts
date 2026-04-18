import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import rateLimit from "express-rate-limit";
import { db, usersTable, notificationSettingsTable, monitorsTable, snapshotsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { hashPassword, verifyPassword, createSession, deleteSession } from "../lib/auth";
import { requireAuth } from "../middlewares/requireAuth";
import { RegisterBody, LoginBody, UpdateProfileBody, ChangePasswordBody, DeleteAccountBody } from "@workspace/api-zod";
import { sendVerificationEmail } from "../lib/email";

const router: IRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts. Please try again in an hour." },
});

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many verification email requests. Please try again later." },
});

router.post("/auth/register", registerLimiter, async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, password, name } = parsed.data;

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({ error: "Email already in use" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const verificationToken = randomBytes(32).toString("hex");
  const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const [user] = await db.insert(usersTable).values({
    email,
    passwordHash,
    name,
    emailVerified: false,
    emailVerificationToken: verificationToken,
    emailVerificationExpiry: verificationExpiry,
  }).returning();

  await db.insert(notificationSettingsTable).values({
    userId: user.id,
    emailEnabled: false,
    emailAddress: email,
    notifyOnChange: true,
    notifyOnError: true,
  });

  sendVerificationEmail({ to: email, name, token: verificationToken }).catch(() => {});

  res.status(201).json({
    status: "pending_verification",
    email,
    message: "Account created. Please check your email to verify your account.",
  });
});

router.post("/auth/login", loginLimiter, async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, password } = parsed.data;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));

  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  if (!user.emailVerified) {
    res.status(403).json({
      error: "Please verify your email address before signing in.",
      code: "EMAIL_NOT_VERIFIED",
      email: user.email,
    });
    return;
  }

  const token = createSession(user.id);
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.json({
    user: { id: user.id, email: user.email, name: user.name, plan: user.plan, subscriptionStatus: user.subscriptionStatus, createdAt: user.createdAt.toISOString() },
    message: "Logged in",
  });
});

router.post("/auth/logout", (req, res): void => {
  const token = req.cookies?.session;
  if (token) deleteSession(token);
  res.clearCookie("session");
  res.json({ message: "Logged out" });
});

router.get("/auth/verify-email", async (req, res): Promise<void> => {
  const token = typeof req.query.token === "string" ? req.query.token : null;
  if (!token) {
    res.status(400).json({ error: "Missing verification token" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.emailVerificationToken, token));

  if (!user) {
    res.status(400).json({ error: "Invalid or expired verification link" });
    return;
  }

  if (user.emailVerified) {
    const sessionToken = createSession(user.id);
    res.cookie("session", sessionToken, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({
      message: "Email already verified",
      user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
    });
    return;
  }

  if (user.emailVerificationExpiry && user.emailVerificationExpiry < new Date()) {
    res.status(400).json({ error: "Verification link has expired. Please request a new one.", code: "TOKEN_EXPIRED" });
    return;
  }

  await db.update(usersTable).set({
    emailVerified: true,
    emailVerificationToken: null,
    emailVerificationExpiry: null,
    updatedAt: new Date(),
  }).where(eq(usersTable.id, user.id));

  const sessionToken = createSession(user.id);
  res.cookie("session", sessionToken, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.json({
    message: "Email verified successfully",
    user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
  });
});

router.post("/auth/resend-verification", resendLimiter, async (req, res): Promise<void> => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : null;

  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));

  if (!user || user.emailVerified) {
    res.json({ message: "If this email exists and is unverified, a new verification link has been sent." });
    return;
  }

  const verificationToken = randomBytes(32).toString("hex");
  const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.update(usersTable).set({
    emailVerificationToken: verificationToken,
    emailVerificationExpiry: verificationExpiry,
    updatedAt: new Date(),
  }).where(eq(usersTable.id, user.id));

  sendVerificationEmail({ to: email, name: user.name, token: verificationToken }).catch(() => {});

  res.json({ message: "If this email exists and is unverified, a new verification link has been sent." });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const userId = (req as typeof req & { userId: number }).userId;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    subscriptionStatus: user.subscriptionStatus,
    createdAt: user.createdAt.toISOString(),
  });
});

router.put("/auth/profile", requireAuth, async (req, res): Promise<void> => {
  const userId = (req as typeof req & { userId: number }).userId;
  const parsed = UpdateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, email } = parsed.data;
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (name !== undefined) {
    if (!name.trim()) {
      res.status(400).json({ error: "Name cannot be empty" });
      return;
    }
    updates.name = name.trim();
  }

  if (email !== undefined) {
    if (!email.trim() || !email.includes("@")) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email.trim().toLowerCase()));
    if (existing && existing.id !== userId) {
      res.status(409).json({ error: "Email already in use" });
      return;
    }
    updates.email = email.trim().toLowerCase();
  }

  await db.update(usersTable).set(updates).where(eq(usersTable.id, userId));
  const [updated] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  res.json({ id: updated.id, email: updated.email, name: updated.name, plan: updated.plan, subscriptionStatus: updated.subscriptionStatus, createdAt: updated.createdAt.toISOString() });
});

router.put("/auth/password", requireAuth, async (req, res): Promise<void> => {
  const userId = (req as typeof req & { userId: number }).userId;
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { currentPassword, newPassword } = parsed.data;

  if (newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  const newHash = await hashPassword(newPassword);
  await db.update(usersTable).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(usersTable.id, userId));
  res.json({ message: "Password updated successfully" });
});

router.delete("/auth/delete-account", requireAuth, async (req, res): Promise<void> => {
  const userId = (req as typeof req & { userId: number }).userId;
  const parsed = DeleteAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const valid = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Password is incorrect" });
    return;
  }

  const monitors = await db.select({ id: monitorsTable.id }).from(monitorsTable).where(eq(monitorsTable.userId, userId));
  if (monitors.length > 0) {
    const ids = monitors.map((m) => m.id);
    await db.delete(snapshotsTable).where(inArray(snapshotsTable.monitorId, ids));
  }
  await db.delete(monitorsTable).where(eq(monitorsTable.userId, userId));
  await db.delete(notificationSettingsTable).where(eq(notificationSettingsTable.userId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));

  const token = req.cookies?.session;
  if (token) deleteSession(token);
  res.clearCookie("session");

  res.json({ message: "Account deleted" });
});

export default router;
