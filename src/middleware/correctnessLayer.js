/**
 * correctnessLayer.js
 * 
 * The actual product: prevent hallucinated/wrong code BEFORE it's generated,
 * not after. Most hallucination happens because the LLM is missing facts
 * it could never have guessed — exact versions, existing function names,
 * file structure, the actual error, what was already tried.
 * 
 * This layer forces those specific facts to be present before execution.
 * If they're missing, it blocks execution and asks for them — this is
 * what saves the user from getting code back, finding it doesn't work,
 * and burning hours debugging hallucinated assumptions.
 */

// ── Critical facts checklist per task type ────────────────────────────────────
// These are the things that, if missing, WILL cause hallucination.
const CRITICAL_FACTS = {
  code: [
    {
      id: "exact_error",
      check: (ctx) => /error|bug|fix|broken|fail|crash/i.test(ctx.goal ?? ""),
      required: "the_exact_error_message",
      askIfMissing: "Paste the exact error message or stack trace — not a paraphrase. This is the #1 cause of wrong fixes.",
    },
    {
      id: "existing_code",
      check: (ctx) => /fix|refactor|extend|add to|modify|update/i.test(ctx.goal ?? ""),
      required: "the_actual_existing_code",
      askIfMissing: "Paste the actual code you want changed — not a description of it. The LLM cannot guess your implementation.",
    },
    {
      id: "dependency_versions",
      check: (ctx) => /\b(library|package|framework|version|upgrade|migrate)\b/i.test(ctx.goal ?? ""),
      required: "exact_versions",
      askIfMissing: "What exact version are you on? APIs change between versions — guessing here causes broken code.",
    },
    {
      id: "what_already_tried",
      check: (ctx) => /still|again|not working|doesn't work|already tried/i.test(ctx.goal ?? ""),
      required: "prior_attempts",
      askIfMissing: "What have you already tried? Repeating a failed approach wastes your tokens twice.",
    },
  ],
  analysis: [
    {
      id: "actual_data",
      check: (ctx) => /\b(data|numbers|results|metrics|performance)\b/i.test(ctx.goal ?? ""),
      required: "real_numbers",
      askIfMissing: "Do you have actual numbers/data, or do you want general guidance? Specifics prevent made-up statistics.",
    },
  ],
};

// ── Run the correctness check ─────────────────────────────────────────────────
/**
 * @param {object} ctx        structured context (from interviewer or extractor)
 * @param {string} taskType
 * @returns {{ 
 *   blocked: boolean, 
 *   missingCritical: array, 
 *   warningMessage: string|null 
 * }}
 */
export const checkCorrectness = (ctx, taskType) => {
  const checks = CRITICAL_FACTS[taskType] ?? [];
  const fullText = [ctx.goal, ctx.raw_intent, ctx.constraints].filter(Boolean).join(" ");

  const missingCritical = [];
  for (const fact of checks) {
    if (fact.check(ctx)) {
      // This fact type is relevant to the task — check if we already have it
      const alreadyProvided = fullText.length > 150 || // long input likely has the details
        new RegExp(fact.required.replace(/_/g, ".{0,3}"), "i").test(fullText);

      if (!alreadyProvided) {
        missingCritical.push(fact);
      }
    }
  }

  return {
    blocked:         missingCritical.length > 0,
    missingCritical,
    warningMessage:  missingCritical.length > 0
      ? missingCritical[0].askIfMissing
      : null,
  };
};

// ── Hallucination risk score ───────────────────────────────────────────────────
// Shown to the user so they understand WHY we're asking — builds trust
export const calculateHallucinationRisk = (ctx, taskType, missingCritical) => {
  let risk = 10; // baseline — even perfect context has some risk

  risk += missingCritical.length * 25;
  if (!ctx.constraints) risk += 10;
  if (!ctx.domain_context) risk += 5;
  if ((ctx.goal ?? "").length < 30) risk += 15;

  risk = Math.min(95, risk);

  return {
    score: risk,
    level: risk >= 60 ? "high" : risk >= 30 ? "medium" : "low",
    message: risk >= 60
      ? "High risk of hallucinated output — missing critical facts"
      : risk >= 30
      ? "Moderate risk — some assumptions will be made"
      : "Low risk — context is well-grounded",
  };
};