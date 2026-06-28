/**
 * promptBuilder.js
 * Converts structured context → tight, grounded prompt.
 * Two hard rules baked into every prompt:
 *   1. Only use provided context (no hallucination)
 *   2. Strict output format (no drift)
 */

/**
 * Build the system prompt — static grounding layer.
 * ~50 tokens. Always cacheable on Anthropic's side (use it as system prefix).
 */
export const buildSystemPrompt = (ctx, taskType = "factual") => {
  const roleMap = {
    code:           "You are a precise software engineer.",
    analysis:       "You are a rigorous analyst.",
    creative:       "You are a skilled writer.",
    transformation: "You are an expert editor.",
    summarization:  "You are a concise summarizer.",
    factual:        "You are a knowledgeable, factual assistant.",
  };

  const role = ctx.domain_context
    ? `You are an expert in ${ctx.domain_context}.`
    : roleMap[taskType] ?? roleMap.factual;

  return [
    role,
    "Use ONLY the information provided in the user message.",
    "If something is not stated, say you don't know — never infer or fabricate.",
    "No preamble. No sign-off. Output exactly what is asked, nothing more.",
  ].join(" ");
};

/**
 * Build the user prompt — structured context injection.
 * Every token here is deliberate. No filler words.
 */
export const buildOptimizedPrompt = (ctx, taskType = "factual") => {
  const parts = [];

  // Context block — only include fields that exist
  const contextParts = [];
  if (ctx.audience)        contextParts.push(`Audience: ${ctx.audience}`);
  if (ctx.domain_context)  contextParts.push(`Domain: ${ctx.domain_context}`);
  if (ctx.constraints)     contextParts.push(`Constraints: ${ctx.constraints}`);

  if (contextParts.length > 0) {
    parts.push("--- Context ---");
    parts.push(contextParts.join("\n"));
    parts.push("--- End context ---");
  }

  // Task — verb-first, single sentence
  const goal = ctx.goal || ctx.raw_intent;
  parts.push(`Task: ${goal}`);

  // Tone (only if relevant)
  if (ctx.tone) parts.push(`Tone: ${ctx.tone}`);

  // Output format — explicit shape + length cap
  const formatInstruction = buildFormatInstruction(ctx, taskType);
  parts.push(formatInstruction);

  return parts.join("\n");
};

/**
 * Build a tight output format instruction based on task type + user preference.
 * This single line kills 80% of output drift and over-generation.
 */
const buildFormatInstruction = (ctx, taskType) => {
  // User explicitly specified format — respect it exactly
  if (ctx.format) return `Output format: ${ctx.format}`;

  // Infer from task type
  const formatDefaults = {
    code:           "Output format: Code only, no explanation unless asked. Use markdown code blocks.",
    analysis:       "Output format: Structured bullet points. Max 5 points. Each under 20 words.",
    creative:       "Output format: Prose only. No headers. No meta-commentary about the writing.",
    transformation: "Output format: Transformed text only. No explanation of changes made.",
    summarization:  "Output format: 3–5 bullet points. Each one sentence. Most important point first.",
    factual:        "Output format: Direct answer first, then 1–2 sentences of explanation if needed.",
  };

  return formatDefaults[taskType] ?? formatDefaults.factual;
};