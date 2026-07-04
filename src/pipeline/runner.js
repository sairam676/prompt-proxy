/**
 * runner.js
 * 
 * Orchestrates the full pipeline:
 * 1. Extract context + identify root cause (our Groq — free)
 * 2. Call user's LLM with surgical prompt (their key — their credits)
 * 3. Interpret the response into clear actions (our Groq — free)
 * 
 * The user's expensive LLM is called exactly ONCE with a perfect prompt.
 * Everything else is our cheap Groq models doing the thinking work.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI    from "openai";
import { extractAndAnalyze } from "./extractor.js";
import { interpretResponse } from "./interpreter.js";

// ── Call user's own LLM with the surgical prompt ──────────────────────────────
const callUserLLM = async (provider, apiKey, surgicalPrompt, onStep) => {
  onStep({ type: "status", message: `Calling your ${provider === "claude" ? "Claude" : "OpenAI"} account...` });

  if (provider === "claude") {
    const client   = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 1024,
      messages:   [{ role: "user", content: surgicalPrompt }],
    });
    const text = response.content[0].text;
    onStep({
      type:    "llm_done",
      message: "Your LLM responded",
      data:    {
        inputTokens:  response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model:        response.model,
      },
    });
    return text;
  }

  if (provider === "openai") {
    const client   = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model:      "gpt-4o-mini",
      max_tokens: 1024,
      messages:   [{ role: "user", content: surgicalPrompt }],
    });
    const text = response.choices[0].message.content;
    onStep({
      type:    "llm_done",
      message: "Your LLM responded",
      data:    {
        inputTokens:  response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        model:        response.model,
      },
    });
    return text;
  }

  throw new Error(`Unsupported provider: ${provider}`);
};

// ── Main pipeline runner ───────────────────────────────────────────────────────
/**
 * @param {object} structuredContext  — from the interviewer
 * @param {string} provider           — "claude" | "openai"
 * @param {string} apiKey             — user's own key
 * @param {function} onStep           — called with each step update for SSE streaming
 */
export const runPipeline = async (structuredContext, provider, apiKey, onStep) => {
  // Step 1: Extract + analyze (our Groq)
  onStep({ type: "step", step: 1, total: 3, message: "Extracting context and identifying root cause..." });
  const analysis = await extractAndAnalyze(structuredContext, onStep);

  // Block if critical info is missing — don't waste their credits
  if (analysis.missing_critical) {
    onStep({
      type:    "needs_info",
      message: analysis.missing_critical,
    });
    return { blocked: true, reason: analysis.missing_critical };
  }

  // Step 2: Call their LLM once with the surgical prompt (their credits)
  onStep({ type: "step", step: 2, total: 3, message: "Sending surgical prompt to your LLM..." });
  const llmResponse = await callUserLLM(provider, apiKey, analysis.surgical_prompt, onStep);

  // Step 3: Interpret the response (our Groq)
  onStep({ type: "step", step: 3, total: 3, message: "Interpreting the solution..." });
  const interpretation = await interpretResponse(llmResponse, analysis, onStep);

  // Done
  const result = {
    blocked:        false,
    rootCause:      analysis.root_cause,
    problemArea:    analysis.problem_area,
    severity:       analysis.severity,
    surgicalPrompt: analysis.surgical_prompt,
    rawLLMResponse: llmResponse,
    interpretation,
    tokensSaved:    estimateTokensSaved(structuredContext, analysis.surgical_prompt),
  };

  onStep({ type: "done", message: "Pipeline complete", data: result });
  return result;
};

// Rough estimate: user would have done 5 back-and-forth turns without us
const estimateTokensSaved = (ctx, surgicalPrompt) => {
  const rawLen      = (ctx.raw_intent ?? "").length;
  const naiveTurns  = 5;
  const naiveTokens = Math.ceil(rawLen / 4) * naiveTurns * 3; // input + output + repeat context
  const ourTokens   = Math.ceil(surgicalPrompt.length / 4);
  return Math.max(0, naiveTokens - ourTokens);
};