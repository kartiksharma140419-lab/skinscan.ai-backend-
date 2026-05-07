import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { analyzeImage } from "../services/ai.js";
import { uploadImage } from "../services/storage.js";
import { getPersonalisedRemedies } from "../services/remedies.js";
import { calculatePercentile } from "../utils/percentile.js";
import { validateImage } from "../utils/imageQuality.js";

const router = Router();
router.use(requireAuth);

// POST /api/scan/analyze
router.post(
  "/analyze",
  upload.single("image"),
  async (req: AuthRequest, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "Image file is required", code: "VALIDATION_ERROR" });
        return;
      }

      const scanTypeSchema = z.enum(["face", "hair"]);
      const scanTypeParsed = scanTypeSchema.safeParse(req.body.scan_type);
      if (!scanTypeParsed.success) {
        res.status(400).json({ error: "scan_type must be 'face' or 'hair'", code: "VALIDATION_ERROR" });
        return;
      }
      const scanType = scanTypeParsed.data;

      const validation = validateImage(file);
      if (!validation.valid) {
        res.status(400).json({ error: validation.error, code: "VALIDATION_ERROR" });
        return;
      }

      // Get user profile for personalisation
      const { data: user } = await supabase
        .from("users")
        .select("age, skin_type, concern")
        .eq("id", req.userId!)
        .single();

      // Compress image with sharp
      const compressed = await sharp(file.buffer)
        .resize({ width: 1024, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      // Upload to Supabase Storage
      const scanId = uuidv4();
      const storagePath = `scans/${req.userId}/${scanId}.jpg`;
      const imageUrl = await uploadImage(compressed, storagePath);

      // Call Gemini AI
      const aiResult = await analyzeImage(compressed, scanType);

      if (aiResult["image_quality"] === "poor") {
        res.status(400).json({
          error: "Image quality is too poor for analysis. Please ensure good lighting and a clear, close-up photo.",
          code: "POOR_IMAGE_QUALITY",
        });
        return;
      }

      const score = Number(aiResult["score"]) || 5.0;
      const severity = (aiResult["severity"] as "mild" | "moderate" | "serious") ?? "mild";

      // Calculate percentile
      const percentile = await calculatePercentile(user?.age ?? 25, scanType, score);

      // Get personalised remedies
      const remedies = getPersonalisedRemedies(
        scanType,
        severity,
        (user?.skin_type as "oily" | "dry" | "combination" | "normal") ?? null,
        (aiResult["remedy_categories"] as string[]) ?? [],
      );

      // Insert scan record
      const { data: scan, error: insertError } = await supabase
        .from("scans")
        .insert({
          id: scanId,
          user_id: req.userId,
          scan_type: scanType,
          image_url: imageUrl,
          score,
          severity,
          percentile,
          condition_raw: aiResult,
          remedies: remedies,
        })
        .select("id, score, severity, percentile, remedies, condition_raw")
        .single();

      if (insertError) {
        req.log.error({ insertError }, "scan insert error");
        res.status(500).json({ error: "Failed to save scan", code: "SERVER_ERROR" });
        return;
      }

      res.json({
        scan_id: scan.id,
        score: scan.score,
        severity: scan.severity,
        percentile: scan.percentile,
        remedies: scan.remedies,
        condition_raw: scan.condition_raw,
      });
    } catch (err) {
      req.log.error({ err }, "scan analyze error");
      res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
    }
  },
);

// GET /api/scan/result/:scan_id
router.get("/result/:scan_id", async (req: AuthRequest, res) => {
  try {
    const { scan_id } = req.params;

    const { data: scan, error } = await supabase
      .from("scans")
      .select("*")
      .eq("id", scan_id)
      .eq("user_id", req.userId!)
      .single();

    if (error || !scan) {
      res.status(404).json({ error: "Scan not found", code: "NOT_FOUND" });
      return;
    }

    res.json(scan);
  } catch (err) {
    req.log.error({ err }, "scan result error");
    res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

export default router;
