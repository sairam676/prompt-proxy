import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * taskRouter.js
 *
 * Classifies whether an incoming message is a debugging task (needs the
 * full interview -> evidence/confidence -> verification -> repair pipeline)
 * or a general/conceptual question (just wants a direct answer). This is a
 * classification, not a diagnosis — same category as buildBrief's
 * complexity check, safe to hand to a cheap model.
 *
 * LLM classification (Groq) is primary — it generalizes to phrasing regex
 * can't anticipate (this replaced a regex heuristic that false-positived on
 * plain English containing an apostrophe). A regex fallback exists ONLY for
 * when the Groq call itself fails (network error, malformed response) — so
 * classification never blocks the whole pipeline on an external call being
 * down. An explicit user-picked mode always wins over both.
 */

const CLASSIFIER_PROMPT = `
Classify whether the user's message is a DEBUGGING task or a GENERAL question.

DEBUGGING: describes a bug, error, crash, unexpected behavior, or asks to
fix/diagnose something specific, usually (but not always) with code attached.

GENERAL: asks to explain a concept, compare approaches, or any other
knowledge/learning question with nothing specific broken to diagnose.

Output ONLY this JSON, nothing else:
{"taskType": "debug" | "general"}
`.trim();

// Regex fallback — used only if the Groq classification call fails.
const DEBUG_SIGNALS = /\b(bug|error|crash|fix|debug|not working|failing|broken|exception|leak|slow|timeout|security|vulnerability|race|deadlock|performance|stack trace|undefined is not|cannot read propert)\b/i;

const classifyWithRegexFallback = (message) => {
  const hasCodeBlock = /```/.test(message) || /\bfunction\b.*\{|\bconst\b.*=.*\(/i.test(message);
  const hasDebugSignal = DEBUG_SIGNALS.test(message);
  return (hasDebugSignal || hasCodeBlock) ? "debug" : "general";
};

export const classifyTaskType = async (message, explicitMode) => {
  if (explicitMode === "debug" || explicitMode === "general") {
    return explicitMode;
  }

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant", // pure classification, not judgment — 8B is fine
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLASSIFIER_PROMPT },
        { role: "user", content: message },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content.trim());
    if (parsed.taskType === "debug" || parsed.taskType === "general") {
      return parsed.taskType;
    }
    // Valid JSON but wrong shape — fall through to regex fallback below.
  } catch (_) {
    // Groq call failed or returned unparseable JSON — don't let a network
    // hiccup block routing entirely, fall back to the deterministic regex.
  }

  return classifyWithRegexFallback(message);
};