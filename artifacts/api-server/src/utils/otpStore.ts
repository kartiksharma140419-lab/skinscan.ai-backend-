import { supabase } from "../lib/supabase.js";

/** How long a new OTP stays valid (minutes). */
const OTP_EXPIRY_MINUTES = 10;

/**
 * Persist an OTP for the given email.
 * If an OTP already exists for this email it is replaced (upsert).
 */
export async function saveOTP(email: string, otp: string): Promise<void> {
  const key = email.toLowerCase();
  const expiresAt = new Date(
    Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000,
  ).toISOString();

  // Delete any previous rows for this email, then insert fresh.
  // This avoids unique-constraint issues and keeps the table clean.
  await supabase.from("otp_codes").delete().eq("email", key);

  const { error } = await supabase
    .from("otp_codes")
    .insert({ email: key, otp, expires_at: expiresAt, used: false });

  if (error) {
    throw new Error(`Failed to save OTP: ${error.message}`);
  }
}

/**
 * Verify an OTP for the given email.
 * Returns `true` only when the OTP matches, has not expired,
 * and has not already been used. Marks the row as `used` on success.
 */
export async function verifyOTP(
  email: string,
  inputOtp: string,
): Promise<boolean> {
  const key = email.toLowerCase();
  const now = new Date().toISOString();

  // Look for a matching, unexpired, unused OTP
  const { data, error } = await supabase
    .from("otp_codes")
    .select("id")
    .eq("email", key)
    .eq("otp", inputOtp)
    .eq("used", false)
    .gt("expires_at", now)
    .limit(1)
    .single();

  if (error || !data) return false;

  // Mark as used so it cannot be replayed
  const { error: updErr } = await supabase
    .from("otp_codes")
    .update({ used: true })
    .eq("id", data.id);
  if (updErr) console.error("Failed to mark OTP used:", updErr);

  return true;
}

/**
 * Check whether the email has a successfully verified (used) OTP
 * that is still recent (within the last hour).
 */
export async function isEmailVerified(email: string): Promise<boolean> {
  const key = email.toLowerCase();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from("otp_codes")
    .select("id")
    .eq("email", key)
    .eq("used", true)
    .gt("expires_at", oneHourAgo)
    .limit(1)
    .single();

  return !!data;
}

/**
 * Remove the verified-email record so it cannot be reused.
 * Called after successful register / login.
 */
export async function clearVerifiedEmail(email: string): Promise<void> {
  const key = email.toLowerCase();
  await supabase.from("otp_codes").delete().eq("email", key);
}

/**
 * Delete all OTP rows older than 1 hour.
 * Intended to be called from a scheduled cron job.
 */
export async function cleanupExpiredOTPs(): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("otp_codes")
    .delete()
    .lt("expires_at", cutoff)
    .select("id");

  if (error) {
    throw new Error(`OTP cleanup failed: ${error.message}`);
  }

  return data?.length ?? 0;
}
