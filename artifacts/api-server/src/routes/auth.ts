import { Router } from "express";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { saveOTP, verifyOTP, isEmailVerified, clearVerifiedEmail } from "../utils/otpStore.js";
import { getFirebaseAuth } from "../services/firebase.js";

const JWT_SECRET = process.env["JWT_SECRET"];
const JWT_REFRESH_SECRET = process.env["JWT_REFRESH_SECRET"];

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("FATAL: JWT_SECRET environment variable must be set and at least 32 characters long. Server cannot start.");
}
if (!JWT_REFRESH_SECRET || JWT_REFRESH_SECRET.length < 32) {
  throw new Error("FATAL: JWT_REFRESH_SECRET environment variable must be set and at least 32 characters long. Server cannot start.");
}

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
    connectionTimeout: 5000,
    socketTimeout: 5000,
  });
}

const jwtSecret = process.env.JWT_SECRET as string;
const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET as string;

function generateTokens(payload: {
  user_id: string;
  email: string;
  is_subscribed: boolean;
}): { access_token: string; refresh_token: string } {
  const access_token = jwt.sign(payload, jwtSecret, { expiresIn: "15m" });
  const refresh_token = jwt.sign({ user_id: payload.user_id }, jwtRefreshSecret, {
    expiresIn: "30d",
  });

  return { access_token, refresh_token };
}

const SendOtpSchema = z.object({
  email: z.string().email(),
});

const VerifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6).regex(/^\d{6}$/, "OTP must be 6 digits"),
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

const MAX_OTP_PER_WINDOW = 3;
const WINDOW_DURATION_MS = 15 * 60 * 1000;

// POST /api/auth/send-otp
router.post("/send-otp", async (req, res) => {
  try {
    const parsed = SendOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: "Invalid or missing email address" });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    
    // Rate limit check
    const now = Date.now();
    const { data: rl } = await supabase
      .from("otp_rate_limits")
      .select("*")
      .eq("email", email)
      .single();

    if (rl) {
      if (now - Number(rl.window_start) < WINDOW_DURATION_MS) {
        if (rl.count >= MAX_OTP_PER_WINDOW) {
          res.status(429).json({ success: false, message: "Too many OTP requests. Please wait 15 minutes." });
          return;
        }
        await supabase
          .from("otp_rate_limits")
          .update({ count: rl.count + 1 })
          .eq("email", email);
      } else {
        // Reset window
        await supabase
          .from("otp_rate_limits")
          .update({ count: 1, window_start: now })
          .eq("email", email);
      }
    } else {
      await supabase
        .from("otp_rate_limits")
        .insert({ email, count: 1, window_start: now });
    }

    const otp = generateOTP();
    await saveOTP(email, otp);

    const transporter = createTransporter();
    try {
      await transporter.sendMail({
        from: process.env["GMAIL_USER"],
        to: email,
        subject: "Your OTP Code",
        text: `Your OTP is: ${otp}. It is valid for 10 minutes.`,
      });
    } catch (mailErr) {
      req.log.error({ mailErr }, "Failed to send OTP email");
      // Hardening: Delete the row so a stale OTP is not left in the DB
      await supabase.from("otp_codes").delete().eq("email", email);
      
      // Rollback rate limit
      if (rl && now - Number(rl.window_start) < WINDOW_DURATION_MS) {
        await supabase.from("otp_rate_limits").update({ count: rl.count }).eq("email", email);
      } else {
        await supabase.from("otp_rate_limits").delete().eq("email", email);
      }

      res.status(500).json({ success: false, message: "Failed to send OTP email." });
      return;
    }

    res.json({ success: true, message: "OTP sent successfully" });
  } catch (err) {
    req.log.error({ err }, "send-otp error");
    res.status(500).json({ success: false, message: "Failed to process OTP request. Please try again." });
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
    const valid = await verifyOTP(email, otp);

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

    if (!(await isEmailVerified(email))) {
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

    await clearVerifiedEmail(email);

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

    if (!(await isEmailVerified(email))) {
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

    await clearVerifiedEmail(email);

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

    let payload: { user_id: string };
    try {
      payload = jwt.verify(parsed.data.refresh_token, JWT_REFRESH_SECRET) as { user_id: string };
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
      JWT_SECRET,
      { expiresIn: "15m" },
    );

    res.json({ access_token });
  } catch (err) {
    req.log.error({ err }, "refresh error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

const GoogleAuthSchema = z.object({
  id_token: z.string().min(1),
});

// POST /api/auth/google
router.post("/google", async (req, res) => {
  try {
    const parsed = GoogleAuthSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "id_token is required", code: "VALIDATION_ERROR" });
      return;
    }

    // Verify the Firebase ID token via Admin SDK
    let decoded;
    try {
      decoded = await getFirebaseAuth().verifyIdToken(parsed.data.id_token);
    } catch {
      res.status(401).json({ error: "Invalid or expired Google token", code: "UNAUTHORIZED" });
      return;
    }

    const email = decoded.email;
    if (!email) {
      res.status(400).json({ error: "Google account has no email", code: "VALIDATION_ERROR" });
      return;
    }

    // Find or create the user
    const { data: existing } = await supabase
      .from("users")
      .select("id, name, is_subscribed, email")
      .eq("email", email)
      .single();

    let user = existing;

    if (!user) {
      const displayName = decoded.name || decoded.email?.split("@")[0] || "FRIEND";

      const { data: newUser, error } = await supabase
        .from("users")
        .insert({ email, name: displayName.toUpperCase() })
        .select("id, name, is_subscribed, email")
        .single();

      if (error) {
        req.log.error({ error }, "google-auth: insert user error");
        res.status(500).json({ error: "Failed to create user", code: "SERVER_ERROR" });
        return;
      }
      user = newUser;
    }

    const tokens = generateTokens({
      user_id: user.id,
      email: user.email,
      is_subscribed: user.is_subscribed,
    });

    res.json({
      ...tokens,
      user: { id: user.id, name: user.name, is_subscribed: user.is_subscribed },
      is_new_user: !existing,
    });
  } catch (err) {
    req.log.error({ err }, "google-auth error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

export default router;
