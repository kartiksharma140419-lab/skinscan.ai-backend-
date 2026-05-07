import { supabase } from "../lib/supabase.js";

export async function calculatePercentile(
  userAge: number,
  scanType: "face" | "hair",
  newScore: number,
): Promise<number> {
  const { count: below } = await supabase
    .from("scans")
    .select("id", { count: "exact", head: true })
    .eq("scan_type", scanType)
    .lt("score", newScore)
    .gte("users.age", userAge - 5)
    .lte("users.age", userAge + 5);

  const { count: total } = await supabase
    .from("scans")
    .select("id", { count: "exact", head: true })
    .eq("scan_type", scanType)
    .gte("users.age", userAge - 5)
    .lte("users.age", userAge + 5);

  if (!total || total === 0) return 50;
  return Math.round(((below ?? 0) / total) * 100);
}
