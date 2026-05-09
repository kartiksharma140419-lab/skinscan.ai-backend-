import { Router } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { generateDailyTasks } from "../services/remedies.js";

const router = Router();
router.use(requireAuth);

// GET /api/tracker/today
router.get("/today", async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const today = new Date().toISOString().split("T")[0];

    // Get user profile
    const { data: user } = await supabase
      .from("users")
      .select("skin_type, concern, is_subscribed, streak, created_at")
      .eq("id", userId)
      .single();

    if (!user) {
      res.status(404).json({ error: "User not found", code: "NOT_FOUND" });
      return;
    }

    // Check if tasks already exist for today
    const { data: existingTasks } = await supabase
      .from("tracker_tasks")
      .select("*")
      .eq("user_id", userId)
      .eq("task_date", today);

    let tasks = existingTasks;

    if (!tasks || tasks.length === 0) {
      // Calculate day number in journey
      const createdAt = new Date(user.created_at);
      const dayNumber = Math.floor(
        (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24),
      );

      const generated = generateDailyTasks(
        user.skin_type,
        user.concern ?? "both",
        dayNumber,
        user.is_subscribed,
      );

      const rows = generated.map((r) => ({
        user_id: userId,
        task_date: today,
        task_key: r.key,
        task_title: r.title,
        task_icon: r.icon,
        category: r.category,
        duration_minutes: r.duration_minutes,
        is_premium: r.is_premium,
        completed: false,
      }));

      const { data: inserted, error } = await supabase
        .from("tracker_tasks")
        .insert(rows)
        .select("*");

      if (error) {
        req.log.error({ error }, "tracker: task insert error");
        res.status(500).json({ error: "Failed to generate tasks", code: "SERVER_ERROR" });
        return;
      }
      tasks = inserted ?? [];
    }

    const total = tasks.length;
    const completed = tasks.filter((t) => t.completed).length;
    const completion_percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    res.json({
      tasks: tasks.map((t) => ({
        id: t.id,
        task_key: t.task_key,
        task_title: t.task_title,
        task_icon: t.task_icon,
        category: t.category,
        duration_minutes: t.duration_minutes,
        is_premium: t.is_premium,
        completed: t.completed,
      })),
      streak: user.streak ?? 0,
      completion_percentage,
    });
  } catch (err) {
    req.log.error({ err }, "tracker today error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

const CompleteSchema = z.object({ completed: z.boolean() });

// PATCH /api/tracker/task/:task_id/complete
router.patch("/task/:task_id/complete", async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const { task_id } = req.params;

    const parsed = CompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "completed (boolean) is required", code: "VALIDATION_ERROR" });
      return;
    }

    const { error: updateError } = await supabase
      .from("tracker_tasks")
      .update({ completed: parsed.data.completed, completed_at: new Date().toISOString() })
      .eq("id", task_id)
      .eq("user_id", userId);

    if (updateError) {
      res.status(500).json({ error: "Failed to update task", code: "SERVER_ERROR" });
      return;
    }

    const today = new Date().toISOString().split("T")[0];

    // Check if all today's tasks are done
    const { data: todayTasks } = await supabase
      .from("tracker_tasks")
      .select("completed")
      .eq("user_id", userId)
      .eq("task_date", today);

    const allDone = todayTasks?.every((t) => t.completed) ?? false;

    let newStreak = 0;

    if (allDone) {
      // Check yesterday
      const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
      const { data: yesterdayTasks } = await supabase
        .from("tracker_tasks")
        .select("completed")
        .eq("user_id", userId)
        .eq("task_date", yesterday);

      const { data: user } = await supabase
        .from("users")
        .select("streak")
        .eq("id", userId)
        .single();

      const yesterdayAllDone =
        yesterdayTasks && yesterdayTasks.length > 0 && yesterdayTasks.every((t) => t.completed);

      newStreak = yesterdayAllDone ? (user?.streak ?? 0) + 1 : 1;

      await supabase
        .from("users")
        .update({ streak: newStreak, last_task_date: today })
        .eq("id", userId);
    }

    res.json({ completed: parsed.data.completed, streak: newStreak, all_done: allDone });
  } catch (err) {
    req.log.error({ err }, "tracker complete error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// GET /api/tracker/history
router.get("/history", async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;

    const { data: scans, error } = await supabase
      .from("scans")
      .select("score, scan_type, created_at")
      .eq("user_id", userId)
      .gte(
        "created_at",
        new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000).toISOString()
      )
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) {
      res.status(500).json({ error: "Failed to fetch history", code: "SERVER_ERROR" });
      return;
    }

    // Group by week + scan_type and average scores
    const weekMap: Record<string, { face: number[]; hair: number[] }> = {};

    for (const scan of scans ?? []) {
      const date = new Date(scan.created_at);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const week = weekStart.toISOString().split("T")[0] ?? "";

      if (!weekMap[week]) weekMap[week] = { face: [], hair: [] };
      const entry = weekMap[week]!;

      if (scan.scan_type === "face") entry.face.push(scan.score);
      else entry.hair.push(scan.score);
    }

    const avg = (arr: number[]) =>
      arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;

    const face_history = Object.entries(weekMap)
      .map(([week, v]) => ({ week, score: avg(v.face) }))
      .filter((x) => x.score !== null);

    const hair_history = Object.entries(weekMap)
      .map(([week, v]) => ({ week, score: avg(v.hair) }))
      .filter((x) => x.score !== null);

    res.json({ face_history, hair_history });
  } catch (err) {
    req.log.error({ err }, "tracker history error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// GET /api/tracker/comparison-photos
router.get("/comparison-photos", async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const scanType = (req.query["scan_type"] as string) ?? "face";

    const { data: first } = await supabase
      .from("scans")
      .select("id, image_url, score, created_at")
      .eq("user_id", userId)
      .eq("scan_type", scanType)
      .not("image_url", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    const { data: latest } = await supabase
      .from("scans")
      .select("id, image_url, score, created_at")
      .eq("user_id", userId)
      .eq("scan_type", scanType)
      .not("image_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    res.json({
      first: first
        ? { image_url: first.image_url, score: first.score, date: first.created_at }
        : null,
      latest: latest
        ? { image_url: latest.image_url, score: latest.score, date: latest.created_at }
        : null,
    });
  } catch (err) {
    req.log.error({ err }, "comparison photos error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

export default router;
