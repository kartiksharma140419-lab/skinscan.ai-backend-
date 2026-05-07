import { getMessaging } from "./firebase.js";
import { logger } from "../lib/logger.js";

export async function sendPush(
  fcmToken: string,
  title: string,
  body: string,
): Promise<void> {
  try {
    const messaging = getMessaging();
    await messaging.send({
      token: fcmToken,
      notification: { title, body },
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
    });
  } catch (err) {
    logger.error({ err, fcmToken }, "FCM push failed");
  }
}
