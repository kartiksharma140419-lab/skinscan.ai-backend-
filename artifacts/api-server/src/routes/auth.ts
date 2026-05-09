import { Router } from "express";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { saveOTP, verifyOTP, isEmailVerified, clearVerifiedEmail } from "../utils/otpStore.js";

const router = Router();

function generateOTP(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env["GMAIL_USER"],
      pass: process.env["GMAIL_PASS"],
    },
  });
}

function generateTokens(payload: {
  user_id: string;
  email: string;
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

const SendOtpSchema = z.object({
  email: z.string().email(),
});

const VerifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});

const RegisterSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  age: z.number().int().min(10).max(100).optional(),
  skin_type: z.enum(["oily", "dry", "combination", "normal"]).optional(),
  hair_type: z.enum(["straight", "wavy", "curly", "coily"]).optional(),
  concern: z.enum(["skin", "hair", "both"]).optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
});

const RefreshSchema = z.object({ refresh_token: z.string() });

// POST /api/auth/send-otp
router.post("/send-otp", async (req, res) => {
  try {
    const parsed = SendOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: "Invalid or missing email address" });
      return;
    }

    const { email } = parsed.data;
    const otp = generateOTP();
    saveOTP(email, otp);

    const transporter = createTransporter();
    await transporter.sendMail({
      from: process.env["GMAIL_USER"],
      to: email,
      subject: "Your OTP Code",
      text: `Your OTP is: ${otp}. It is valid for 5 minutes.`,
    });

    res.json({ success: true, message: "OTP sent successfully" });
  } catch (err) {
    req.log.error({ err }, "send-otp error");
    res.status(500).json({ success: false, message: "Failed to send OTP. Please try again." });
  }
});

// POST /api/auth/verify-otp
router.post("/verify-otp", async (req, res) => {
  try {
    const parsed = VerifyOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: "Email and 6-digit OTP are required" });
      return;
    }

    const { email, otp } = parsed.data;
    const valid = verifyOTP(email, otp);

    if (!valid) {
      res.status(401).json({ success: false, message: "Invalid or expired OTP" });
      return;
    }

    res.json({ success: true, message: "OTP verified successfully" });
  } catch (err) {
    req.log.error({ err }, "verify-otp error");
    res.status(500).json({ success: false, message: "Internal server error" });
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

    const { email, name, age, skin_type, hair_type, concern } = parsed.data;

    if (!isEmailVerified(email)) {
      res.status(401).json({ error: "Email not verified. Please verify OTP first.", code: "UNAUTHORIZED" });
      return;
    }

    const { data: existing } = await supabase
      .from("users")
      .select("id, name, is_subscribed, email")
      .eq("email", email)
      .single();

    let user = existing;

    if (!user) {
      const { data: newUser, error } = await supabase
        .from("users")
        .insert({ email, name, age, skin_type, hair_type, concern })
        .select("id, name, is_subscribed, email")
        .single();

      if (error) {
        req.log.error({ error }, "register: insert user error");
        res.status(500).json({ error: "Failed to create user", code: "SERVER_ERROR" });
        return;
      }
      user = newUser;
    }

    clearVerifiedEmail(email);

    const tokens = generateTokens({
      user_id: user.id,
      email: user.email,
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

    const { email } = parsed.data;

    if (!isEmailVerified(email)) {
      res.status(401).json({ error: "Email not verified. Please verify OTP first.", code: "UNAUTHORIZED" });
      return;
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("id, name, is_subscribed, email")
      .eq("email", email)
      .single();

    if (error || !user) {
      res.status(404).json({ error: "User not found. Please register first.", code: "NOT_FOUND" });
      return;
    }

    clearVerifiedEmail(email);

    const tokens = generateTokens({
      user_id: user.id,
      email: user.email,
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
      .select("id, email, is_subscribed")
      .eq("id", payload.user_id)
      .single();

    if (!user) {
      res.status(401).json({ error: "User not found", code: "UNAUTHORIZED" });
      return;
    }

    const access_token = jwt.sign(
      { user_id: user.id, email: user.email, is_subscribed: user.is_subscribed },
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
