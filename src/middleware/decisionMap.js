/**
 * decisionMap.js
 * 
 * For complex tasks, break the work into subtasks and route each one
 * to the cheapest model that can handle it correctly.
 * 
 * Philosophy (ponytail-inspired):
 * - Only use a heavy model where reasoning genuinely matters
 * - Cheap model for structure/formatting/simple facts
 * - Heavy model only for: architecture decisions, multi-step logic,
 *   code that must be correct, nuanced analysis
 */

// ── Model routing tiers ────────────────────────────────────────────────────────
export const MODELS = {
  // Tier 1 — fast, cheap, good for structure and simple tasks
  light: {
    id:          "llama-3.1-8b-instant",   // Groq — fastest, cheapest
    maxTokens:   512,
    costPer1M:   0.05,
    goodFor:     ["formatting", "simple_fact", "summarization", "transformation"],
  },
  // Tier 2 — balanced, handles most tasks well
  medium: {
    id:          "llama-3.3-70b-versatile", // Groq — your current model
    maxTokens:   700,
    costPer1M:   0.59,
    goodFor:     ["analysis", "creative", "code", "factual"],
  },
  // Tier 3 — heavy, only for genuinely complex reasoning
  heavy: {
    id:          "llama-3.3-70b-versatile", // upgrade to mixtral/claude if needed
    maxTokens:   1200,
    costPer1M:   0.59,
    goodFor:     ["architecture", "multi_step_code", "complex_analysis", "debugging"],
  },
};

// ── Decision map ───────────────────────────────────────────────────────────────
/**
 * Given structured context, decide:
 * 1. Which model tier to use
 * 2. Whether to decompose into subtasks
 * 3. What the execution plan looks like
 */
export const buildDecisionMap = (ctx, taskType) => {
  const complexity = ctx.complexity ?? inferComplexity(ctx, taskType);

  // Simple tasks — one shot, light/medium model
  if (complexity === "simple") {
    return {
      strategy:   "single_call",
      model:      MODELS.light,
      subtasks:   null,
      reasoning:  "Simple task — single call with light model",
    };
  }

  // Medium tasks — one shot, medium model
  if (complexity === "medium") {
    return {
      strategy:   "single_call",
      model:      MODELS.medium,
      subtasks:   null,
      reasoning:  "Medium complexity — single call with balanced model",
    };
  }

  // Complex tasks — decompose into subtasks, route each appropriately
  if (complexity === "complex") {
    const subtasks = decomposeTask(ctx, taskType);
    return {
      strategy:  "decomposed",
      model:     MODELS.medium,      // default for final synthesis
      subtasks,
      reasoning: `Complex task — decomposed into ${subtasks.length} subtasks`,
    };
  }

  // Fallback
  return {
    strategy:  "single_call",
    model:     MODELS.medium,
    subtasks:  null,
    reasoning: "Fallback to medium model",
  };
};

// ── Infer complexity from context ──────────────────────────────────────────────
const inferComplexity = (ctx, taskType) => {
  const goal = (ctx.goal ?? ctx.raw_intent ?? "").toLowerCase();
  const wordCount = goal.split(" ").length;

  // Signals of complexity
  const complexSignals = [
    "architect", "design system", "compare and", "trade-off", "step by step",
    "debug", "why is", "best approach", "production", "scale", "migrate",
    "refactor entire", "multi-step", "end to end",
  ];
  const simpleSignals = [
    "what is", "define", "explain briefly", "one line", "syntax for",
    "convert", "translate", "summarize this", "fix this typo",
  ];

  if (complexSignals.some(s => goal.includes(s))) return "complex";
  if (simpleSignals.some(s => goal.includes(s))) return "simple";
  if (wordCount < 8) return "simple";
  if (taskType === "analysis" || taskType === "code") return "medium";

  return "medium";
};

// ── Decompose complex task into subtasks ───────────────────────────────────────
const decomposeTask = (ctx, taskType) => {
  const goal = ctx.goal ?? ctx.raw_intent ?? "";

  if (taskType === "code") {
    return [
      { id: 1, name: "Understand requirements",  model: MODELS.light,  prompt: `List the exact requirements for: ${goal}. Be specific. Output as numbered list.` },
      { id: 2, name: "Design approach",           model: MODELS.medium, prompt: `Given these requirements, outline the implementation approach. No code yet. Just the plan.` },
      { id: 3, name: "Implement",                 model: MODELS.medium, prompt: `Implement the solution based on the plan above. Clean, minimal code only.` },
      { id: 4, name: "Review for edge cases",     model: MODELS.light,  prompt: `List any edge cases or error conditions not handled in the code above.` },
    ];
  }

  if (taskType === "analysis") {
    return [
      { id: 1, name: "Identify key dimensions",  model: MODELS.light,  prompt: `What are the 3-5 most important dimensions to analyze for: ${goal}? Output as list.` },
      { id: 2, name: "Analyze each dimension",   model: MODELS.medium, prompt: `For each dimension identified, provide a concise, factual analysis.` },
      { id: 3, name: "Synthesize conclusion",    model: MODELS.medium, prompt: `Based on the analysis above, provide a clear conclusion and recommendation.` },
    ];
  }

  // Default decomposition for other complex tasks
  return [
    { id: 1, name: "Break down the task",   model: MODELS.light,  prompt: `Break this into clear sub-goals: ${goal}` },
    { id: 2, name: "Execute each sub-goal", model: MODELS.medium, prompt: `Complete each sub-goal from above thoroughly.` },
    { id: 3, name: "Synthesize output",     model: MODELS.light,  prompt: `Combine the above into a clean, final response.` },
  ];
};