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

// ─── Admin gate ─────────────────────────────────────────────
//
// The filing library, rendered PDFs, findings and the Claude spend cap are a
// single shared corpus — there is no per-user ownership on any of it. So the
// routes that DESTROY shared data or move shared money need a privilege check
// on top of "is logged in", or any account can wipe the library or disable the
// spend guard for everyone.
//
// Admins are listed in ADMIN_EMAILS (comma-separated). This FAILS CLOSED: with
// the variable unset nobody is an admin and the guarded routes return 403.
// That is deliberate — a security gate that silently does nothing when
// unconfigured is the usual way these fixes end up worthless.
function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string | undefined): boolean {
  if (!email) return false;
  return adminEmails().has(email.trim().toLowerCase());
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (isAdminEmail(req.user?.email)) {
    next();
    return;
  }
  res.status(403).json({
    error:
      "This action is restricted to administrators. It affects the shared filing " +
      "library or the team-wide Claude spend cap.",
  });
}

// ─── Signup invite code ─────────────────────────────────────
//
// Registration reaches the public internet, and any account can read the whole
// shared corpus, so signup is gated on a shared invite code from
// SIGNUP_INVITE_CODE. Also fails closed: with no code configured, registration
// is disabled rather than open.
export function signupCodeConfigured(): boolean {
  return !!(process.env.SIGNUP_INVITE_CODE || "").trim();
}

export function checkSignupCode(supplied: unknown): boolean {
  const expected = (process.env.SIGNUP_INVITE_CODE || "").trim();
  if (!expected) return false;
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(supplied.trim());
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths first. That
  // leaks the code's length, which is not a meaningful secret here.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Surface misconfiguration at boot rather than at the moment a user is blocked.
export function logAuthConfig(): void {
  const admins = adminEmails();
  if (admins.size === 0) {
    console.warn(
      "[auth] ADMIN_EMAILS is not set — no account can delete filings, re-render, " +
        "cancel runs, or change the review spend cap. Set it to a comma-separated " +
        "list of admin email addresses.",
    );
  } else {
    console.log(`[auth] ${admins.size} admin account(s) configured via ADMIN_EMAILS.`);
  }
  if (!signupCodeConfigured()) {
    console.warn(
      "[auth] SIGNUP_INVITE_CODE is not set — registration is DISABLED. Set it to " +
        "the shared signup code you hand out to your team.",
    );
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
