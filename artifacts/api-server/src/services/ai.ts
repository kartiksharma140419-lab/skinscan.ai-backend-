import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "../lib/logger.js";

const genAI = new GoogleGenerativeAI(process.env["GEMINI_API_KEY"] ?? "");

const FACE_PROMPT = `You are a non-diagnostic skin analysis assistant. Analyze skin photos for general severity scoring only. Never diagnose medical conditions. Never recommend medicines. Return ONLY valid JSON with no markdown, no code fences:
{"score": <1.0-10.0>, "severity": "<mild|moderate|serious>", "primary_concern": "<string, no medical terms>", "contributing_factors": ["<string>"], "remedy_categories": ["<string>"], "confidence": <0-1>, "image_quality": "<good|fair|poor>"}`;

const HAIR_PROMPT = `You are a non-diagnostic hair analysis assistant. Analyze hair/scalp photos for general severity scoring only. Never diagnose medical conditions. Never recommend medicines. Return ONLY valid JSON with no markdown, no code fences:
{"score": <1.0-10.0>, "severity": "<mild|moderate|serious>", "recession_pattern": "<none|early|moderate|advanced>", "density_assessment": "<normal|thinning|sparse>", "remedy_categories": ["<string>"], "confidence": <0-1>, "image_quality": "<good|fair|poor>"}`;

export async function analyzeImage(
  imageBuffer: Buffer,
  scanType: "face" | "hair",
): Promise<Record<string, unknown>> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const prompt = scanType === "face" ? FACE_PROMPT : HAIR_PROMPT;

  const imagePart = {
    inlineData: {
      data: imageBuffer.toString("base64"),
      mimeType: "image/jpeg" as const,
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  const text = result.response.text().trim();

  let cleaned = text;
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/, "").replace(/```$/, "").trim();
  }

  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch (err) {
    logger.error({ err, text }, "Failed to parse Gemini response");
    throw new Error("AI returned invalid JSON");
  }
}
