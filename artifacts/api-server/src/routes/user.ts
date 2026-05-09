import { Router } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { deleteImage, getPathFromUrl } from "../services/storage.js";

const router = Router();
router.use(requireAuth);

function getSeasonalBanner(): { title: string; tip: string; mode: string } {
  const month = new Date().getMonth() + 1;
  if (month >= 6 && month <= 9) {
    return {
      title: "Monsoon Skin Care",
      tip: "Humidity spikes bacteria — cleanse twice daily and never skip toner.",
      mode: "monsoon",
    };
  }
  if (month >= 3 && month <= 5) {
    return {
      title: "Summer Skin Shield",
      tip: "SPF 30+ is non-negotiable. Apply sunscreen 20 min before going out.",
      mode: "summer",
    };
  }
  if (month === 12 || month <= 2) {
    return {
      title: "Winter Skin Rescue",
      tip: "Cold air is drying — layer a rich moisturiser over your serum tonight.",
      mode: "winter",
    };
  }
  return {
    title: "Seasonal Skin Tip",
    tip: "Consistency is your best skin care tool — keep the streak going!",
    mode: "neutral",
  };
}

function getTrend(current: number, previous: number | undefined): "up" | "down" | "stable" {
  if (previous === undefined) return "stable";
  if (current > previous + 0.4) return "up";
  if (current < previous - 0.4) return "down";
  return "stable";
}

// GET /api/user/dashboard
router.get("/dashboard", async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;

    const { data: user } = await supabase
      .from("users")
      .select("streak")
      .eq("id", userId)
      .single();

    // Last two face scans
    const { data: faceScans } = await supabase
      .from("scans")
      .select("score, severity, created_at")
      .eq("user_id", userId)
      .eq("scan_type", "face")
      .order("created_at", { ascending: false })
      .limit(2);

    // Last two hair scans
    const { data: hairScans } = await supabase
      .from("scans")
      .select("score, severity, created_at")
      .eq("user_id", userId)
      .eq("scan_type", "hair")
      .order("created_at", { ascending: false })
      .limit(2);

    // Today's tracker completion
    const today = new Date().toISOString().split("T")[0];
    const { data: tasks } = await supabase
      .from("tracker_tasks")
      .select("completed")
      .eq("user_id", userId)
      .eq("task_date", today);

    const total = tasks?.length ?? 0;
    const completed = tasks?.filter((t) => t.completed).length ?? 0;
    const tracker_completion = total > 0 ? Math.round((completed / total) * 100) : 0;

    const lastFace = faceScans?.[0] ?? null;
    const prevFace = faceScans?.[1];
    const lastHair = hairScans?.[0] ?? null;
    const prevHair = hairScans?.[1];

    res.json({
      last_face_scan: lastFace
        ? { ...lastFace, trend: getTrend(lastFace.score, prevFace?.score) }
        : null,
      last_hair_scan: lastHair
        ? { ...lastHair, trend: getTrend(lastHair.score, prevHair?.score) }
        : null,
      tracker_completion,
      streak: user?.streak ?? 0,
      seasonal_banner: getSeasonalBanner(),
    });
  } catch (err) {
    req.log.error({ err }, "dashboard error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// GET /api/user/profile
router.get("/profile", async (req: AuthRequest, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.userId!)
      .single();

    if (error || !user) {
      res.status(404).json({ error: "User not found", code: "NOT_FOUND" });
      return;
    }
    res.json(user);
  } catch (err) {
    req.log.error({ err }, "profile error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

const PrefsSchema = z.object({
  reminder_time: z.string().optional(),
  language: z.string().max(5).optional(),
  fcm_token: z.string().optional(),
  notifications_enabled: z.boolean().optional(),
});

const PhoneSchema = z.object({
  phone_number: z.string().min(7).max(15),
});

// PATCH /api/user/preferences
router.patch("/preferences", async (req: AuthRequest, res) => {
  try {
    const parsed = PrefsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "VALIDATION_ERROR" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.reminder_time !== undefined) updates["reminder_time"] = parsed.data.reminder_time;
    if (parsed.data.language !== undefined) updates["language"] = parsed.data.language;
    if (parsed.data.fcm_token !== undefined) updates["fcm_token"] = parsed.data.fcm_token;
    if (parsed.data.notifications_enabled !== undefined) updates["notifications_enabled"] = parsed.data.notifications_enabled;
    const { data: user, error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", req.userId!)
      .select("*")
      .single();

    if (error) {
      res.status(500).json({ error: "Failed to update preferences", code: "SERVER_ERROR" });
      return;
    }

    res.json(user);
  } catch (err) {
    req.log.error({ err }, "preferences error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// GET /api/user/profile
router.get("/profile", async (req: AuthRequest, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.userId!)
      .single();

    if (error || !user) {
      res.status(404).json({ error: "User not found", code: "NOT_FOUND" });
      return;
    }

    res.json(user);
  } catch (err) {
    req.log.error({ err }, "profile error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// GET /api/user/scan-history
router.get("/scan-history", async (req: AuthRequest, res) => {
  try {
    const { data: scans, error } = await supabase
      .from("scans")
      .select("*")
      .eq("user_id", req.userId!)
      .order("created_at", { ascending: false });

    if (error) {
      res.status(500).json({ error: "Failed to fetch scan history", code: "SERVER_ERROR" });
      return;
    }

    res.json(scans ?? []);
  } catch (err) {
    req.log.error({ err }, "scan-history error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// PATCH /api/user/phone
router.patch("/phone", async (req: AuthRequest, res) => {
  try {
    const parsed = PhoneSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid phone number", code: "VALIDATION_ERROR" });
      return;
    }

    const { data: user, error } = await supabase
      .from("users")
      .update({ phone_number: parsed.data.phone_number })
      .eq("id", req.userId!)
      .select("id, phone_number")
      .single();

    if (error) {
      res.status(500).json({ error: "Failed to update phone number", code: "SERVER_ERROR" });
      return;
    }

    res.json({ success: true, phone_number: user.phone_number });
  } catch (err) {
    req.log.error({ err }, "update phone error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// DELETE /api/user/photos
router.delete("/photos", async (req: AuthRequest, res) => {
  try {
    const { data: scans } = await supabase
      .from("scans")
      .select("id, image_url")
      .eq("user_id", req.userId!)
      .not("image_url", "is", null);

    let deleted_count = 0;
    for (const scan of scans ?? []) {
      const path = getPathFromUrl(scan.image_url);
      if (path) {
        await deleteImage(path).catch(() => {});
        deleted_count++;
      }
    }

    await supabase
      .from("scans")
      .update({ image_url: null })
      .eq("user_id", req.userId!);

    res.json({ deleted_count });
  } catch (err) {
    req.log.error({ err }, "delete photos error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

export default router;
