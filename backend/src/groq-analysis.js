/**
 * groq-analysis.js
 * Calls Groq LLM to analyze face-tracking signals and produce a cheating risk verdict.
 * Falls back gracefully when GROQ_API_KEY is not set.
 */

import Groq from "groq-sdk";

// In-memory cache: attemptId -> { risk, verdict, flags, updatedAt }
const verdictCache = new Map();

let groqClient = null;

function getGroqClient(apiKey) {
  if (!apiKey) return null;
  if (!groqClient) {
    groqClient = new Groq({ apiKey });
  }
  return groqClient;
}

/**
 * Analyze accumulated face-tracking signals and return a risk verdict.
 * @param {object} signals - { windowSeconds, faceAbsentCount, multipleFacesCount, gazeDeviationCount, totalFrames, examTitle }
 * @param {string} attemptId
 * @param {string} apiKey - GROQ_API_KEY
 * @param {string} preferredModel - Optional model name override
 * @returns {Promise<{risk: string, verdict: string, flags: string[]}>}
 */
export async function analyzeFaceSignals(signals, attemptId, apiKey, preferredModel = "") {
  const groq = getGroqClient(apiKey);
  if (!groq) {
    return { risk: "unknown", verdict: "Groq API key not configured. Face signals recorded but not analyzed.", flags: [] };
  }

  const {
    windowSeconds = 30,
    faceAbsentCount = 0,
    multipleFacesCount = 0,
    gazeDeviationCount = 0,
    totalFrames = 0,
    examTitle = "Unknown Exam",
  } = signals;

  const faceAbsentPct = totalFrames > 0 ? Math.round((faceAbsentCount / totalFrames) * 100) : 0;
  const multipleFacesPct = totalFrames > 0 ? Math.round((multipleFacesCount / totalFrames) * 100) : 0;
  const gazeDeviationPct = totalFrames > 0 ? Math.round((gazeDeviationCount / totalFrames) * 100) : 0;

  const prompt = `You are an AI anti-cheat monitor for an online exam portal called Veritas. You analyze real-time face-tracking signals from a candidate's webcam and produce a concise risk verdict.

Exam: "${examTitle}"
Monitoring window: ${windowSeconds} seconds (${totalFrames} frames analyzed)
Face absent: ${faceAbsentCount} frames (${faceAbsentPct}%)
Multiple faces detected: ${multipleFacesCount} frames (${multipleFacesPct}%)
Gaze deviation (looking away): ${gazeDeviationCount} frames (${gazeDeviationPct}%)

Based on these signals, assess the cheating risk. Consider:
- Face absent >20% = suspicious (candidate may have left)
- Multiple faces >5% = very suspicious (someone helping)
- Gaze deviation >40% = moderately suspicious (reading notes/phone)
- Short window (<10 frames) = insufficient data

Respond ONLY with valid JSON in this exact format (no markdown, no explanation outside the JSON):
{"risk":"low"|"medium"|"high","verdict":"1-2 sentence human-readable verdict","flags":["flag1","flag2"]}

Risk levels: low = no significant anomalies, medium = suspicious patterns, high = strong cheating indicators.`;

  const modelCandidates = [
    preferredModel,
    process.env.GROQ_MODEL,
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant",
  ].filter(Boolean);

  let lastError = null;

  for (const model of modelCandidates) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 250,
      });

      const choice = completion.choices[0]?.message;
      const raw = (choice?.content || choice?.reasoning || "").trim();
      // Extract JSON even if there's surrounding text or thought process
      const jsonMatch = raw.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const result = {
          risk: ["low", "medium", "high"].includes(parsed.risk) ? parsed.risk : "medium",
          verdict: String(parsed.verdict || "Analysis complete."),
          flags: Array.isArray(parsed.flags) ? parsed.flags : [],
          modelUsed: model,
        };
        verdictCache.set(attemptId, { ...result, updatedAt: Date.now() });
        return result;
      }
      throw new Error(`No JSON in response from model ${model}: ${raw.slice(0, 100)}`);
    } catch (err) {
      lastError = err;
      // If error suggests model not found or rate limit, try the next model candidate
      continue;
    }
  }

  const fallback = { risk: "unknown", verdict: `Analysis error: ${lastError?.message || "All models failed"}`, flags: [] };
  verdictCache.set(attemptId, { ...fallback, updatedAt: Date.now() });
  return fallback;
}

/** Get the latest cached verdict for an attempt */
export function getLatestVerdict(attemptId) {
  return verdictCache.get(attemptId) || null;
}

/** Clear verdict cache for an attempt (call on submit/stop) */
export function clearVerdict(attemptId) {
  verdictCache.delete(attemptId);
}
