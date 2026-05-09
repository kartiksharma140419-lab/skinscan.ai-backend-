import { supabase } from "../lib/supabase.js";

/**
 * Calculate what percentile the new score falls in,
 * compared to other scans from users in the same age bracket (±5 years).
 *
 * Returns a number 0-100 (e.g. 72 = better than 72% of peers).
 */
export async function calculatePercentile(
  userAge: number,
  scanType: "face" | "hair",
  newScore: number,
): Promise<number> {
  // Step 1: Get user IDs in the same age bracket
  const minAge = userAge - 5;
  const maxAge = userAge + 5;

  const { data: peers } = await supabase
    .from("users")
    .select("id")
    .gte("age", minAge)
    .lte("age", maxAge);

  const peerIds = peers?.map((p) => p.id) ?? [];

  // No peers in this age range — return neutral percentile
  if (peerIds.length === 0) return 50;

  // Step 2: Count scans from these peers that scored below the new score
  const { count: below } = await supabase
    .from("scans")
    .select("id", { count: "exact", head: true })
    .eq("scan_type", scanType)
    .lt("score", newScore)
    .in("user_id", peerIds);

  // Step 3: Count total scans from these peers
  const { count: total } = await supabase
    .from("scans")
    .select("id", { count: "exact", head: true })
    .eq("scan_type", scanType)
    .in("user_id", peerIds);

  if (!total || total === 0) return 50;
  return Math.round(((below ?? 0) / total) * 100);
}
