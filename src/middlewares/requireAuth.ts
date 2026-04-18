import { type Request, type Response, type NextFunction } from "express";
import { getSession } from "../lib/auth";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.session;
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const session = getSession(token);
  if (!session) {
    res.status(401).json({ error: "Session expired or invalid" });
    return;
  }
  (req as Request & { userId: number }).userId = session.userId;
  next();
}
