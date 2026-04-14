import { type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { storage } from "./storage";

const BCRYPT_ROUNDS = 12;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = "sid";

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      user?: { id: number; email: string; displayName: string };
    }
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSession(res: Response, userId: number): Promise<string> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
  await storage.createSession(token, userId, expiresAt);

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  });

  return token;
}

export async function clearSession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    await storage.deleteSession(token);
  }
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const session = await storage.getSession(token);
  if (!session) {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.status(401).json({ error: "Session expired" });
    return;
  }

  // Check expiry
  if (new Date(session.expiresAt) < new Date()) {
    await storage.deleteSession(token);
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.status(401).json({ error: "Session expired" });
    return;
  }

  const user = await storage.getUserById(session.userId);
  if (!user) {
    await storage.deleteSession(token);
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.status(401).json({ error: "User not found" });
    return;
  }

  req.user = { id: user.id, email: user.email, displayName: user.displayName };
  next();
}
