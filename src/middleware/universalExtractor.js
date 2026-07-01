/**
 * universalExtractor.js
 * 
 * Domain-agnostic version of codeContextExtractor.
 * Works on ANY input: code, prose, errors, pasted docs, logs, specs.
 * 
 * Goal: score how complete the input already is, so we only ask
 * the LLM interviewer when genuinely necessary. Zero LLM cost for
 * the detection step itself — pure pattern matching.
 */

// ── Type detectors ────────────────────────────────────────────────────────────
const TYPE_SIGNALS = {
  code: {
    pattern: /```|\b(function|const|class|def |import |SELECT |public class)\b/,
    weight: 30,
  },
  error: {
    pattern: /\b(Error:|Exception|Traceback|at \w+\.|stack trace|failed with)\b/i,
    weight: 25,
  },
  data: {
    pattern: /^[\w\s,"']+\n([\w\s,"']+\n){2,}/m, // CSV-like multi-row structure
    weight: 20,
  },
  spec: {
    pattern: /\b(requirements?:|must (have|support)|should (be|do)|acceptance criteria)\b/i,
    weight: 20,
  },
  question: {
    pattern: /^(what|why|how|when|where|who|which|is|are|can|does)\b/i,
    weight: 10,
  },
};

// ── Completeness signals (things that reduce ambiguity) ───────────────────────
const COMPLETENESS_SIGNALS = [
  { name: "has_goal_verb",    pattern: /\b(fix|build|write|create|explain|compare|optimize|refactor|debug|design|analyze|summarize|translate|convert)\b/i, weight: 20 },
  { name: "has_specifics",    pattern: /\b(in \w+|using \w+|for \w+|with \w+)\b/i,  weight: 15 },
  { name: "has_constraints",  pattern: /\b(must|should|need to|limit|max|under \d|within)\b/i, weight: 10 },
  { name: "has_format_ask",   pattern: /\b(bullet|list|table|paragraph|code|json|markdown|step.by.step)\b/i, weight: 10 },
  { name: "sufficient_length",pattern: /^.{60,}/s, weight: 15 }, // not just 2 words
  { name: "has_audience",     pattern: /\b(for (a |my )?(beginner|expert|team|client|manager|student))\b/i, weight: 10 },
];

// ── Ambiguity signals (things that increase need for clarification) ──────────
const AMBIGUITY_SIGNALS = [
  { name: "too_short",        pattern: /^.{1,15}$/,  penalty: 30 },
  { name: "vague_verb_only",  pattern: /^(help( me)?|explain|do this|fix it)\.?$/i, penalty: 25 },
  { name: "pronoun_no_referent", pattern: /^(it|this|that)\b/i, penalty: 15 },
];

// ── Main scorer ────────────────────────────────────────────────────────────────
/**
 * @param {string} rawInput
 * @returns {{
 *   detectedType, confidence, confidenceLevel,
 *   missingSignals, suggestedQuestion, skipInterview
 * }}
 */
export const extractUniversalContext = (rawInput) => {
  const text = rawInput.trim();

  // 1. Detect primary type
  let detectedType = "general";
  let typeScore = 0;
  for (const [type, { pattern, weight }] of Object.entries(TYPE_SIGNALS)) {
    if (pattern.test(text)) {
      if (weight > typeScore) { detectedType = type; typeScore = weight; }
    }
  }

  // 2. Score completeness
  let completenessScore = 0;
  const foundSignals = [];
  for (const signal of COMPLETENESS_SIGNALS) {
    if (signal.pattern.test(text)) {
      completenessScore += signal.weight;
      foundSignals.push(signal.name);
    }
  }

  // 3. Score ambiguity (penalties)
  let ambiguityPenalty = 0;
  for (const signal of AMBIGUITY_SIGNALS) {
    if (signal.pattern.test(text)) {
      ambiguityPenalty += signal.penalty;
    }
  }

  // 4. Final confidence
  const rawScore = typeScore + completenessScore - ambiguityPenalty;
  const confidence = Math.max(0, Math.min(100, rawScore));
  const confidenceLevel = confidence >= 65 ? "high" : confidence >= 35 ? "medium" : "low";

  // 5. Determine what's missing
  const missingSignals = [];
  if (!foundSignals.includes("has_goal_verb"))     missingSignals.push("goal");
  if (!foundSignals.includes("has_format_ask"))    missingSignals.push("format");
  if (!foundSignals.includes("has_constraints") && detectedType !== "question")
                                                    missingSignals.push("constraints");

  // 6. Build ONE confirming question if medium confidence
  let suggestedQuestion = null;
  if (confidenceLevel === "medium") {
    if (missingSignals.includes("goal")) {
      suggestedQuestion = "What exactly do you want done with this — fix, explain, improve, or something else?";
    } else if (missingSignals.includes("format")) {
      suggestedQuestion = "What output format works best — short answer, list, or detailed explanation?";
    } else {
      suggestedQuestion = "Any specific constraints I should know — length, language, or platform?";
    }
  }

  return {
    detectedType,
    confidence,
    confidenceLevel,
    foundSignals,
    missingSignals,
    suggestedQuestion,
    // High confidence + nothing critical missing → skip the LLM interviewer entirely
    skipInterview: confidenceLevel === "high",
    // Medium → ask exactly one question, don't run full interview loop
    needsOneQuestion: confidenceLevel === "medium",
  };
};

// ── Build structured context directly (used on fast path) ─────────────────────
export const buildContextFromExtraction = (rawInput, extraction) => {
  const goalMatch = rawInput.match(/\b(fix|build|write|create|explain|compare|optimize|refactor|debug|design|analyze|summarize|translate|convert)\b.{0,80}/i);

  return {
    goal:           goalMatch ? goalMatch[0].trim() : rawInput.slice(0, 100),
    audience:       null,
    tone:           null,
    format:         /\b(bullet|list)\b/i.test(rawInput) ? "bullet points"
                    : /\bcode\b/i.test(rawInput) ? "code only"
                    : null,
    constraints:    null,
    domain_context: extraction.detectedType !== "general" ? extraction.detectedType : null,
    raw_intent:     rawInput,
    complexity:     rawInput.length > 200 ? "medium" : "simple",
  };
};