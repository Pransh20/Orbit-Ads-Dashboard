import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export interface AuthedRequest extends Request { userId?: string }

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.orbit_token || req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ message: "Authentication required" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "development-secret") as { sub: string };
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ message: "Your session has expired" });
  }
}
