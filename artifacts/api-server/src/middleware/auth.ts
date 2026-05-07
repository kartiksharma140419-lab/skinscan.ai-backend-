import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  userId?: string;
  userPhone?: string;
  isSubscribed?: boolean;
}

export function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing token", code: "UNAUTHORIZED" });
    return;
  }

  const token = header.slice(7);
  const secret = process.env["JWT_SECRET"];
  if (!secret) {
    res.status(500).json({ error: "Server misconfiguration", code: "SERVER_ERROR" });
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as {
      user_id: string;
      phone: string;
      is_subscribed: boolean;
    };
    req.userId = payload.user_id;
    req.userPhone = payload.phone;
    req.isSubscribed = payload.is_subscribed;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token", code: "UNAUTHORIZED" });
  }
}
