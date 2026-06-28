export const BUDGET_TEMPLATES = {
  factual: {
    grounding: 50, context: 80, instruction: 20, format: 15, buffer: 35,
    maxOutputTokens: 256,
  },
  code: {
    grounding: 50, context: 150, instruction: 30, format: 20, buffer: 100,
    maxOutputTokens: 600,
  },
  analysis: {
    grounding: 50, context: 250, instruction: 25, format: 20, buffer: 80,
    maxOutputTokens: 700,
  },
  creative: {
    grounding: 50, context: 100, instruction: 20, format: 15, buffer: 60,
    maxOutputTokens: 500,
  },
  transformation: {
    grounding: 50, context: 200, instruction: 20, format: 15, buffer: 50,
    maxOutputTokens: 450,
  },
  summarization: {
    grounding: 50, context: 300, instruction: 15, format: 15, buffer: 40,
    maxOutputTokens: 300,
  },
};

const SIGNALS = {
  code:           ["code", "function", "script", "implement", "bug", "debug", "refactor", "api", "class", "algorithm", "program", "sql", "query", "test"],
  analysis:       ["analyze", "analyse", "compare", "evaluate", "explain why", "pros and cons", "trade-off", "review", "assess", "breakdown", "insights"],
  creative:       ["write", "story", "poem", "essay", "blog", "draft", "generate", "create content", "caption", "slogan", "email", "letter", "script"],
  summarization:  ["summarize", "summarise", "summary", "tldr", "shorten", "condense", "key points", "main points", "brief"],
  transformation: ["translate", "rewrite", "rephrase", "convert", "format", "restructure", "paraphrase", "simplify", "reformat"],
  factual:        ["what is", "what are", "who is", "when did", "how does", "define", "explain", "tell me about", "difference between"],
};

export const classifyTask = (ctx) => {
  const text = [ctx.goal, ctx.raw_intent, ctx.domain_context]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const scores = {};
  for (const [type, keywords] of Object.entries(SIGNALS)) {
    scores[type] = keywords.filter((kw) => text.includes(kw)).length;
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const taskType = best[1] > 0 ? best[0] : "factual";
  const confidence = best[1] >= 2 ? "high" : best[1] === 1 ? "medium" : "low";

  return {
    taskType,
    budget: BUDGET_TEMPLATES[taskType],
    confidence,
    totalEstimatedInputTokens: Object.entries(BUDGET_TEMPLATES[taskType])
      .filter(([k]) => k !== "maxOutputTokens")
      .reduce((a, [, v]) => a + v, 0),
  };
};

export const validateBudget = (builtPromptTokens, systemPromptTokens, budget) => {
  const totalInput = builtPromptTokens + systemPromptTokens;
  const budgetTotal = budget.grounding + budget.context + budget.instruction +
                      budget.format + budget.buffer;
  const warnings = [];

  if (totalInput > budgetTotal * 1.3)
    warnings.push(`Prompt ${totalInput} tok is 30%+ over ${budgetTotal} tok budget — trim context`);
  if (totalInput < budgetTotal * 0.4)
    warnings.push(`Prompt ${totalInput} tok is very low — interviewer may have under-extracted`);

  return {
    valid: warnings.length === 0,
    warnings,
    totalInput,
    budgetTotal,
    overBudgetBy: Math.max(0, totalInput - budgetTotal),
  };
};