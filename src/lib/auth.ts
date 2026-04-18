import bcrypt from "bcryptjs";
import crypto from "crypto";

const SALT_ROUNDS = 10;
const SESSION_SECRET = process.env.SESSION_SECRET ?? "changeme-secret";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// In-memory session store (simple, stateless sessions via signed tokens)
const sessions = new Map<string, { userId: number; expiresAt: Date }>();

export function createSession(userId: number): string {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  sessions.set(token, { userId, expiresAt });
  return token;
}

export function getSession(token: string): { userId: number } | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    sessions.delete(token);
    return null;
  }
  return { userId: session.userId };
}

export function deleteSession(token: string): void {
  sessions.delete(token);
}

void SESSION_SECRET;
