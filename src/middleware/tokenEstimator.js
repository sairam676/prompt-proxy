/**
 * tokenEstimator.js
 * Simple character-based token estimator — no external dependencies.
 * Rule: 1 token ≈ 4 characters for English text. ~95% accurate for estimation.
 */

const CHARS_PER_TOKEN = 4;

export const countTokens = (text) => {
  if (!text || typeof text !== "string") return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
};

export const estimateNaiveTokens = (rawUserMessage) => {
  // Without middleware, user typically does 3 back-and-forth turns:
  // system prompt + repeated user message + LLM response, 3 times
  const msgTokens    = countTokens(rawUserMessage);
  const systemTokens = 50;
  const llmPerTurn   = 200;
  return (systemTokens + msgTokens + llmPerTurn) * 3;
};

export const tokenSavingsReport = (rawUserMessage, optimizedPrompt, systemPrompt = "") => {
  const naive     = estimateNaiveTokens(rawUserMessage);
  const optimized = countTokens(optimizedPrompt) + countTokens(systemPrompt);
  const saved     = Math.max(0, naive - optimized);
  const pct       = naive > 0 ? Math.round((saved / naive) * 100) : 0;

  return {
    naiveTokens:           naive,
    optimizedTokens:       optimized,
    tokensSaved:           saved,
    savingsPercent:        pct,
    estimatedCostSavedUSD: parseFloat(((saved / 1_000_000) * 3).toFixed(6)),
    actualInputTokens:     null,
    actualOutputTokens:    null,
    actualTotalCostUSD:    null,
  };
};

export const enrichWithActual = (report, usage) => {
  const inputCost  = (usage.input_tokens  / 1_000_000) * 3;
  const outputCost = (usage.output_tokens / 1_000_000) * 15;
  return {
    ...report,
    actualInputTokens:  usage.input_tokens,
    actualOutputTokens: usage.output_tokens,
    actualTotalCostUSD: parseFloat((inputCost + outputCost).toFixed(6)),
  };
};

export const checkBudgetFit = (builtPromptTokens, systemPromptTokens, budget) => {
  const totalInput  = builtPromptTokens + systemPromptTokens;
  const budgetTotal = budget.grounding + budget.context + budget.instruction +
                      budget.format    + budget.buffer;
  const warnings = [];
  if (totalInput > budgetTotal * 1.3)
    warnings.push(`Over budget by ${totalInput - budgetTotal} tok — trim context`);
  if (totalInput < budgetTotal * 0.3)
    warnings.push(`Very low token use — may have under-extracted context`);
  return { totalInput, budgetTotal, warnings, overBudget: totalInput > budgetTotal };
};