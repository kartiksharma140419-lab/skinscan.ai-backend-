import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { verifyFirebaseIdToken } from "../services/firebase.js";

const router = Router();

const SendOtpSchema = z.object({ phone: z.string().min(10).max(15) });

const RegisterSchema = z.object({
  phone: z.string().min(10).max(15),
  firebase_id_token: z.string(),
  name: z.string().min(1).max(100),
  age: z.number().int().min(10).max(100).optional(),
  skin_type: z.enum(["oily", "dry", "combination", "normal"]).optional(),
  hair_type: z.enum(["straight", "wavy", "curly", "coily"]).optional(),
  concern: z.enum(["skin", "hair", "both"]).optional(),
});

const LoginSchema = z.object({
  phone: z.string().min(10).max(15),
  firebase_id_token: z.string(),
});

const RefreshSchema = z.object({ refresh_token: z.string() });

function generateTokens(payload: {
  user_id: string;
  phone: string;
  is_subscribed: boolean;
}): { access_token: string; refresh_token: string } {
  const jwtSecret = process.env["JWT_SECRET"]!;
  const refreshSecret = process.env["JWT_REFRESH_SECRET"]!;

  const access_token = jwt.sign(payload, jwtSecret, { expiresIn: "15m" });
  const refresh_token = jwt.sign({ user_id: payload.user_id }, refreshSecret, {
    expiresIn: "30d",
  });

  return { access_token, refresh_token };
}

// POST /api/auth/send-otp
// Note: actual OTP sending is handled by Firebase Auth on the client side.
// This endpoint exists as a compatibility shim / confirmation endpoint.
router.post("/send-otp", async (req, res) => {
  try {
    const parsed = SendOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid phone number", code: "VALIDATION_ERROR" });
      return;
    }
    res.json({ success: true, message: "OTP sent via Firebase Auth" });
  } catch (err) {
    req.log.error({ err }, "send-otp error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "VALIDATION_ERROR" });
      return;
    }

    const { phone, firebase_id_token, name, age, skin_type, hair_type, concern } = parsed.data;

    // Verify Firebase ID token
    let verifiedPhone: string;
    try {
      verifiedPhone = await verifyFirebaseIdToken(firebase_id_token);
    } catch {
      res.status(401).json({ error: "Invalid OTP / Firebase token", code: "UNAUTHORIZED" });
      return;
    }

    if (verifiedPhone !== phone && !verifiedPhone.includes(phone.replace(/^\+91/, ""))) {
      res.status(401).json({ error: "Phone number mismatch", code: "UNAUTHORIZED" });
      return;
    }

    // Check if user exists
    const { data: existing } = await supabase
      .from("users")
      .select("id, name, is_subscribed, phone")
      .eq("phone", phone)
      .single();

    let user = existing;

    if (!user) {
      const { data: newUser, error } = await supabase
        .from("users")
        .insert({ phone, name, age, skin_type, hair_type, concern })
        .select("id, name, is_subscribed, phone")
        .single();

      if (error) {
        req.log.error({ error }, "register: insert user error");
        res.status(500).json({ error: "Failed to create user", code: "SERVER_ERROR" });
        return;
      }
      user = newUser;
    }

    const tokens = generateTokens({
      user_id: user.id,
      phone: user.phone,
      is_subscribed: user.is_subscribed,
    });

    res.json({ ...tokens, user: { id: user.id, name: user.name, is_subscribed: user.is_subscribed } });
  } catch (err) {
    req.log.error({ err }, "register error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "VALIDATION_ERROR" });
      return;
    }

    const { phone, firebase_id_token } = parsed.data;

    try {
      await verifyFirebaseIdToken(firebase_id_token);
    } catch {
      res.status(401).json({ error: "Invalid OTP / Firebase token", code: "UNAUTHORIZED" });
      return;
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("id, name, is_subscribed, phone")
      .eq("phone", phone)
      .single();

    if (error || !user) {
      res.status(404).json({ error: "User not found. Please register first.", code: "NOT_FOUND" });
      return;
    }

    const tokens = generateTokens({
      user_id: user.id,
      phone: user.phone,
      is_subscribed: user.is_subscribed,
    });

    res.json({ ...tokens, user: { id: user.id, name: user.name, is_subscribed: user.is_subscribed } });
  } catch (err) {
    req.log.error({ err }, "login error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// POST /api/auth/refresh
router.post("/refresh", async (req, res) => {
  try {
    const parsed = RefreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "refresh_token required", code: "VALIDATION_ERROR" });
      return;
    }

    const refreshSecret = process.env["JWT_REFRESH_SECRET"]!;
    const jwtSecret = process.env["JWT_SECRET"]!;

    let payload: { user_id: string };
    try {
      payload = jwt.verify(parsed.data.refresh_token, refreshSecret) as { user_id: string };
    } catch {
      res.status(401).json({ error: "Invalid or expired refresh token", code: "UNAUTHORIZED" });
      return;
    }

    const { data: user } = await supabase
      .from("users")
      .select("id, phone, is_subscribed")
      .eq("id", payload.user_id)
      .single();

    if (!user) {
      res.status(401).json({ error: "User not found", code: "UNAUTHORIZED" });
      return;
    }

    const access_token = jwt.sign(
      { user_id: user.id, phone: user.phone, is_subscribed: user.is_subscribed },
      jwtSecret,
      { expiresIn: "15m" },
    );

    res.json({ access_token });
  } catch (err) {
    req.log.error({ err }, "refresh error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

export default router;
