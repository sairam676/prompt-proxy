/**
 * runner.js
 * 
 * Orchestrates the full pipeline:
 * 1. Extract + analyze (our Groq — free, fast)
 * 2. Call user's LLM with compressed JSON brief (their key — their credits, one call)
 * 3. Interpret response into complete action output (our Groq — free, fast)
 * 
 * Latency optimizations:
 * - Groq for steps 1 and 3 (fastest inference available)
 * - Right model size: 8B for simple tasks, 70B for complex
 * - Stream output tokens live so user sees progress immediately
 * - No max_tokens truncation — complete information always
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI    from "openai";
import Groq      from "groq-sdk";
import { extractAndAnalyze } from "./extractor.js";
import { interpretResponse } from "./interpreter.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Call user's LLM with the surgical prompt ───────────────────────────────────
const callUserLLM = async (provider, apiKey, surgicalPrompt, complexity, onStep) => {
  onStep({
    type:    "status",
    message: `Sending to your ${provider === "claude" ? "Claude" : "OpenAI"} account...`,
  });

  // Compress the surgical prompt to JSON string for minimal token usage
  const promptText = typeof surgicalPrompt === "object"
    ? `Task: ${surgicalPrompt.task}\n\nContext:\n${surgicalPrompt.context}${
        surgicalPrompt.constraints ? `\n\nConstraints: ${surgicalPrompt.constraints}` : ""
      }${
        surgicalPrompt.already_tried ? `\n\nAlready tried: ${surgicalPrompt.already_tried}` : ""
      }${
        surgicalPrompt.expected ? `\n\nExpected: ${surgicalPrompt.expected}` : ""
      }\n\nReturn format: ${surgicalPrompt.return_format}`
    : surgicalPrompt;

  const systemPrompt = `You are an expert. Respond completely and precisely. 
No preamble. No sign-off. No filler. Every sentence must add information.
Be as detailed as the task requires — do not truncate important information.`;

  if (provider === "claude") {
    const client   = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model:    complexity === "complex" ? "claude-opus-4-6" : "claude-sonnet-4-6",
      // No max_tokens — let it breathe, complete information matters more than brevity
      messages: [{ role: "user", content: promptText }],
      system:   systemPrompt,
    });

    const text = response.content[0].text;
    onStep({
      type:    "llm_done",
      message: "Response received",
      data: {
        inputTokens:  response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model:        response.model,
        // Show token savings vs naive prompting
        naiveEstimate: Math.round((response.usage.input_tokens * 3)),
      },
    });
    return text;
  }

  if (provider === "openai") {
    const client   = new OpenAI({ apiKey });
    const model    = complexity === "complex" ? "gpt-4o" : "gpt-4o-mini";
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: promptText },
      ],
    });

    const text = response.choices[0].message.content;
    onStep({
      type:    "llm_done",
      message: "Response received",
      data: {
        inputTokens:  response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        model:        response.model,
        naiveEstimate: Math.round((response.usage.prompt_tokens * 3)),
      },
    });
    return text;
  }

  throw new Error(`Unsupported provider: ${provider}`);
};

// ── Main pipeline ──────────────────────────────────────────────────────────────
export const runPipeline = async (structuredContext, provider, apiKey, onStep) => {

  // Step 1: Extract + analyze — our Groq, free
  onStep({ type: "step", step: 1, total: 3, message: "Extracting context and identifying root cause..." });
  const analysis = await extractAndAnalyze(structuredContext, onStep);

  // Step 2: Call their LLM once with surgical prompt — their credits
  onStep({ type: "step", step: 2, total: 3, message: "Calling your LLM with surgical prompt..." });
  const llmResponse = await callUserLLM(
    provider, apiKey,
    analysis.surgical_prompt,
    analysis.complexity,
    onStep
  );

  // Step 3: Interpret — our Groq, free
  onStep({ type: "step", step: 3, total: 3, message: "Building your action plan..." });
  const interpretation = await interpretResponse(llmResponse, analysis, structuredContext, onStep);

  const result = {
    blocked:        false,
    rootCause:      analysis.root_cause,
    problemArea:    analysis.problem_area,
    severity:       analysis.severity,
    keyInsight:     analysis.key_insight,
    surgicalPrompt: analysis.surgical_prompt,
    rawLLMResponse: llmResponse,
    interpretation,
    tokensSaved:    estimateTokensSaved(structuredContext, analysis.surgical_prompt),
    whatToVerify:   analysis.what_to_verify,
    potentialRisks: analysis.potential_risks,
  };

  onStep({ type: "done", message: "Done", data: result });
  return result;
};

// Estimate tokens saved vs user doing naive back-and-forth
const estimateTokensSaved = (ctx, surgicalPrompt) => {
  const rawLen      = (ctx.raw_intent ?? ctx.goal ?? "").length;
  const promptLen   = JSON.stringify(surgicalPrompt).length;
  // Naive: user sends vague message, gets wrong answer, clarifies 4-5 times
  const naiveTokens = Math.ceil(rawLen / 4) * 5 * 3;
  const ourTokens   = Math.ceil(promptLen / 4);
  return Math.max(0, naiveTokens - ourTokens);
};