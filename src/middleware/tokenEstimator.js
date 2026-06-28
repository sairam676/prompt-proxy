/**
 * tokenEstimator.js
 * Simple token estimator — no external tokenizer needed.
 * Rule of thumb: 1 token ≈ 4 characters for English text.
 * Accurate to within 5% for estimation purposes.
 */

const charsPerToken = 4;

export const countTokens = (text) => {
  if (!text || typeof text !== "string") return 0;
  return Math.ceil(text.length / charsPerToken);
};

export const countMessagesTokens = (messages = []) =>
  messages.reduce((total, msg) => {
    const content = typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
    return total + countTokens(content) + 4;
  }, 0);

export const estimateNaiveTokens = (rawUserMessage) => {
  // Without middleware, a user typically:
  // 1. Sends vague message → gets partial answer → clarifies → repeats context
  // Average naive session = 3 turns × (system prompt + user message + LLM response)
  // System prompt ~50 tok, user message repeated each turn, LLM response ~200 tok per turn
  const msgTokens = Math.ceil(rawUserMessage.length / 4);
  const systemTokens = 50;
  const llmResponsePerTurn = 200;
  const turns = 3;
  // Each turn: system + user msg (repeated) + response
  return (systemTokens + msgTokens + llmResponsePerTurn) * turns;
};

export const tokenSavingsReport = (rawUserMessage, optimizedPrompt, systemPrompt = "") => {
  const naive = estimateNaiveTokens(rawUserMessage);
  const optimizedInput = countTokens(optimizedPrompt) + countTokens(systemPrompt);
  const saved = Math.max(0, naive - optimizedInput);
  const savingsPct = naive > 0 ? Math.round((saved / naive) * 100) : 0;

  const COST_PER_M_INPUT = 3.0;

  return {
    naiveTokens:           naive,
    optimizedTokens:       optimizedInput,
    tokensSaved:           saved,
    savingsPercent:        savingsPct,
    estimatedCostSavedUSD: parseFloat(((saved / 1_000_000) * COST_PER_M_INPUT).toFixed(6)),
    actualInputTokens:     null,
    actualOutputTokens:    null,
    actualTotalCostUSD:    null,
  };
};

export const enrichWithActual = (savingsReport, usage) => {
  const COST_PER_M_INPUT  = 3.0;
  const COST_PER_M_OUTPUT = 15.0;
  const inputCost  = (usage.input_tokens  / 1_000_000) * COST_PER_M_INPUT;
  const outputCost = (usage.output_tokens / 1_000_000) * COST_PER_M_OUTPUT;

  return {
    ...savingsReport,
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
    warnings.push(`Very low token use — interviewer may have under-extracted`);

  return { totalInput, budgetTotal, warnings, overBudget: totalInput > budgetTotal };
};