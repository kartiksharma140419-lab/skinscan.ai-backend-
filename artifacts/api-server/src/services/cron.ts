import cron from "node-cron";
import { supabase } from "../lib/supabase.js";
import { sendPush } from "./notifications.js";
import { logger } from "../lib/logger.js";
import { deleteImage, getPathFromUrl } from "./storage.js";

function getSeasonalMessage(streak: number): { title: string; body: string } {
  const month = new Date().getMonth() + 1;
  let tip = "Stay consistent for better results!";
  if (month >= 6 && month <= 9) tip = "Monsoon is tough on skin — keep your routine going!";
  else if (month >= 3 && month <= 5) tip = "Summer heat is a skin challenge — don't skip today!";
  else if (month === 12 || month <= 2) tip = "Cold weather dries skin fast — your routine matters!";

  const streakStr = streak > 0 ? ` Your streak: ${streak} days 🔥` : "";
  return {
    title: "SkinScan AI Daily Reminder",
    body: `${tip}${streakStr}`,
  };
}

export function startCronJobs(): void {
  // Daily at 8:00am IST (UTC+5:30 = 2:30 UTC)
  cron.schedule("30 2 * * *", async () => {
    logger.info("Cron: sending daily reminders");
    try {
      const { data: users } = await supabase
        .from("users")
        .select("id, fcm_token, streak")
        .not("fcm_token", "is", null);

      if (!users) return;

      for (const user of users) {
        const { title, body } = getSeasonalMessage(user.streak ?? 0);
        await sendPush(user.fcm_token, title, body);
      }
    } catch (err) {
      logger.error({ err }, "Cron: daily reminder error");
    }
  });

  // Daily at midnight: delete scans older than 90 days from storage
  cron.schedule("0 0 * * *", async () => {
    logger.info("Cron: cleaning old scan images");
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const { data: oldScans } = await supabase
        .from("scans")
        .select("id, image_url")
        .lt("created_at", cutoff)
        .not("image_url", "is", null);

      if (!oldScans) return;

      for (const scan of oldScans) {
        const path = getPathFromUrl(scan.image_url);
        if (path) {
          await deleteImage(path).catch((e) =>
            logger.error({ e, path }, "Failed to delete old scan image"),
          );
        }
        await supabase.from("scans").update({ image_url: null }).eq("id", scan.id);
      }

      logger.info({ count: oldScans.length }, "Cron: cleaned old scan images");
    } catch (err) {
      logger.error({ err }, "Cron: image cleanup error");
    }
  });

  // Daily at midnight: deactivate expired subscriptions
  cron.schedule("5 0 * * *", async () => {
    logger.info("Cron: checking expired subscriptions");
    try {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("users")
        .update({ is_subscribed: false })
        .eq("is_subscribed", true)
        .lt("sub_expires", now);

      if (error) logger.error({ error }, "Cron: subscription deactivation error");
    } catch (err) {
      logger.error({ err }, "Cron: subscription check error");
    }
  });

  logger.info("Cron jobs started");
}
