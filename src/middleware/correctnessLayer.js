/**
 * correctnessLayer.js
 *
 * Checks the brief BEFORE sending to the big LLM.
 * Blocks execution if facts are missing that WILL cause hallucination.
 *
 * Key insight: most wasted debugging hours come from the LLM not having:
 * 1. The ACTUAL error (not a description of it)
 * 2. The ACTUAL existing code (not a description of it)
 * 3. What was ALREADY TRIED (so it doesn't repeat failed solutions)
 *
 * If these are missing for the relevant task, we ask for them first.
 * One extra message from the user saves hours of wrong output.
 */

const CRITICAL_CHECKS = [
  {
    id:          "exact_error",
    relevant:    (ctx) => /error|bug|fix|broken|fail|crash|not working|doesn't work/i.test(ctx.goal ?? "") ||
                          /error|bug|fix|broken|fail|crash/i.test(ctx.raw_intent ?? ""),
    present:     (ctx) => !!ctx.existing_context && ctx.existing_context.length > 30,
    askIfMissing: "To give you a correct fix, I need the actual error message or stack trace and the relevant code. Can you paste both?",
  },
  {
    id:          "existing_code_for_modification",
    relevant:    (ctx) => /refactor|modify|update|extend|add to|change|improve/i.test(ctx.goal ?? ""),
    present:     (ctx) => !!ctx.existing_context && ctx.existing_context.length > 50,
    askIfMissing: "To modify or extend your code correctly, I need to see the actual current implementation. Can you paste the relevant code?",
  },
  {
    id:          "already_tried",
    relevant:    (ctx) => /still|again|already|keep getting|same issue|tried/i.test(ctx.goal ?? "") ||
                          /still|again|already|tried/i.test(ctx.raw_intent ?? ""),
    present:     (ctx) => !!ctx.already_tried,
    askIfMissing: "You mentioned you've tried something already — what specifically? This prevents me from suggesting the same failed approach.",
  },
];

export const checkCorrectness = (ctx, taskType) => {
  const missingCritical = [];

  for (const check of CRITICAL_CHECKS) {
    if (check.relevant(ctx) && !check.present(ctx)) {
      missingCritical.push(check);
    }
  }

  return {
    blocked:         missingCritical.length > 0,
    missingCritical,
    warningMessage:  missingCritical.length > 0 ? missingCritical[0].askIfMissing : null,
  };
};

export const calculateHallucinationRisk = (ctx, taskType, missingCritical) => {
  let risk = 5;

  risk += missingCritical.length * 30;
  if (!ctx.existing_context) risk += 10;
  if (!ctx.constraints)      risk += 5;
  if ((ctx.goal ?? "").length < 20) risk += 20;

  risk = Math.min(95, risk);

  return {
    score:   risk,
    level:   risk >= 60 ? "high" : risk >= 30 ? "medium" : "low",
    message: risk >= 60
      ? "High hallucination risk — missing critical context"
      : risk >= 30
      ? "Moderate risk — LLM will make some assumptions"
      : "Low risk — brief is well-grounded",
  };
};