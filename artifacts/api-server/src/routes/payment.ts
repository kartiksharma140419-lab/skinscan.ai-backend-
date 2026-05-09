import { Router } from "express";
import { createHmac } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import Razorpay from "razorpay";
import { supabase } from "../lib/supabase.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { sendPush } from "../services/notifications.js";

const router = Router();
router.use(requireAuth);

const razorpay = new Razorpay({
  key_id: process.env["RAZORPAY_KEY_ID"] ?? "",
  key_secret: process.env["RAZORPAY_SECRET"] ?? "",
});

const CreateOrderSchema = z.object({
  plan: z.enum(["monthly", "yearly"]),
});

const VerifySchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
});

// POST /api/payment/create-order
router.post("/create-order", async (req: AuthRequest, res) => {
  try {
    const parsed = CreateOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "plan must be 'monthly' or 'yearly'", code: "VALIDATION_ERROR" });
      return;
    }

    const { plan } = parsed.data;
    const amount = plan === "monthly" ? 14900 : 99900;
    const receipt = uuidv4();

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt,
    });

    await supabase.from("payments").insert({
      user_id: req.userId,
      razorpay_order_id: order.id,
      plan,
      amount,
      status: "created",
    });

    res.json({
      order_id: order.id,
      amount,
      currency: "INR",
      key_id: process.env["RAZORPAY_KEY_ID"],
    });
  } catch (err) {
    req.log.error({ err }, "payment create-order error");
    res.status(500).json({ error: "Failed to create payment order", code: "SERVER_ERROR" });
  }
});

// POST /api/payment/verify
router.post("/verify", async (req: AuthRequest, res) => {
  try {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "VALIDATION_ERROR" });
      return;
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = parsed.data;

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = createHmac("sha256", process.env["RAZORPAY_SECRET"] ?? "")
      .update(body)
      .digest("hex");

    if (expected !== razorpay_signature) {
      res.status(400).json({ error: "Invalid payment signature", code: "INVALID_SIGNATURE" });
      return;
    }

    // Get payment record
    const { data: payment } = await supabase
      .from("payments")
      .select("plan")
      .eq("razorpay_order_id", razorpay_order_id)
      .single();

    if (!payment) {
      res.status(404).json({ error: "Payment record not found", code: "NOT_FOUND" });
      return;
    }

    // Update payment record
    const { error: payErr } = await supabase
      .from("payments")
      .update({ status: "paid", razorpay_payment_id })
      .eq("razorpay_order_id", razorpay_order_id);
    if (payErr) req.log.error({ payErr }, "Payment status update failed");

    // Calculate subscription expiry
    const now = new Date();
    const sub_expires =
      payment.plan === "monthly"
        ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
        : new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    const { error: userErr } = await supabase
      .from("users")
      .update({ is_subscribed: true, sub_expires: sub_expires.toISOString() })
      .eq("id", req.userId!);
    if (userErr) req.log.error({ userErr }, "User subscription update failed");

    // Send push notification
    const { data: user } = await supabase
      .from("users")
      .select("fcm_token")
      .eq("id", req.userId!)
      .single();

    if (user?.fcm_token) {
      await sendPush(
        user.fcm_token,
        "SkinScan AI Premium Unlocked!",
        "Your full tracker plan is now active. Start your 8-task daily routine today!",
      );
    }

    res.json({ success: true, sub_expires: sub_expires.toISOString() });
  } catch (err) {
    req.log.error({ err }, "payment verify error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// GET /api/payment/status
router.get("/status", async (req: AuthRequest, res) => {
  try {
    const { data: user } = await supabase
      .from("users")
      .select("is_subscribed, sub_expires")
      .eq("id", req.userId!)
      .single();

    res.json({
      is_subscribed: user?.is_subscribed ?? false,
      sub_expires: user?.sub_expires ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "payment status error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

export default router;
