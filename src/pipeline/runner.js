/**
 * runner.js
 *
 * REDESIGNED — see extractor.js and fixVerifier.js for the full reasoning.
 * Short version: chaining several small models to "pre-diagnose" before the
 * real LLM saw the problem was backwards. It produced confident wrong
 * answers (see: the tax bracket case, where the diagnosis didn't even match
 * the code) instead of letting the model actually capable of reasoning do
 * the reasoning.
 *
 * New flow:
 * 1. Groq lays out the user's context into one clean brief (cheap, fast —
 *    this is compression, not judgment, small model is fine for it)
 * 2. ONE call to the user's real LLM — diagnoses, fixes, and self-critiques
 *    itself in the same call. If it's not confident, IT says so and asks a
 *    specific question, instead of a weak model guessing on its behalf.
 * 3. Deterministic npm registry check on whatever code it produced — the
 *    one thing worth checking with a fact lookup instead of another opinion.
 * 4. Groq structures the raw response into the UI's action-plan shape
 *    (cheap, fast — formatting, not judgment).
 *
 * Two Groq calls total (down from up to five), one paid call (same as
 * before), and the model doing the actual thinking is the one capable of it.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI    from "openai";
import Groq      from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { buildBrief, buildDiagnosticPrompt } from "./extractor.js";
import { verifyFix }         from "./fixVerifier.js";
import { interpretResponse } from "./interpreter.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Call user's LLM ─────────────────────────────────────────────────────────
const callUserLLM = async (provider, apiKey, promptText, complexity, onStep) => {
  onStep({
    type:    "status",
    message: `Sending to your ${
      provider === "claude" ? "Claude" : provider === "groq" ? "Groq" : "OpenAI"
    } account...`,
  });

  const systemPrompt = `You are an expert debugger. Respond completely and precisely.
No preamble. No sign-off. No filler. Every sentence must add information.
Be as detailed as the task requires — do not truncate important information.`;

  if (provider === "claude") {
    const client   = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model:    complexity === "complex" ? "claude-opus-4-6" : "claude-sonnet-4-6",
      messages: [{ role: "user", content: promptText }],
      system:   systemPrompt,
    });
    const text = response.content[0].text;
    onStep({
      type: "llm_done", message: "Response received",
      data: {
        inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
        model: response.model, naiveEstimate: Math.round(response.usage.input_tokens * 3),
      },
    });
    return text;
  }

  if (provider === "openai") {
    const client   = new OpenAI({ apiKey });
    const model    = complexity === "complex" ? "gpt-4o" : "gpt-4o-mini";
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: promptText }],
    });
    const text = response.choices[0].message.content;
    onStep({
      type: "llm_done", message: "Response received",
      data: {
        inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens,
        model: response.model, naiveEstimate: Math.round(response.usage.prompt_tokens * 3),
      },
    });
    return text;
  }

  if (provider === "groq") {
    const model = complexity === "complex" ? "llama-3.3-70b-versatile" : "llama-3.1-8b-instant";
    const response = await groq.chat.completions.create({
      model, max_tokens: 4096,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: promptText }],
    });
    const text = response.choices[0].message.content;
    onStep({
      type: "llm_done", message: "Response received",
      data: {
        inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens,
        model: response.model,
      },
    });
    return text;
  }



// ...inside callUserLLM, before the "Unsupported provider" throw:

if (provider === "gemini") {
  const genAI = new GoogleGenerativeAI(apiKey);
 const modelName = complexity === "complex" ? "gemini-pro-latest" : "gemini-flash-latest";
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
  });

  const result   = await model.generateContent(promptText);
  const response = result.response;
  const text     = response.text();

  onStep({
    type: "llm_done", message: "Response received",
    data: {
      inputTokens:  response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      model:        modelName,
      naiveEstimate: Math.round((response.usageMetadata?.promptTokenCount ?? 0) * 3),
    },
  });
  return text;
}

  throw new Error(`Unsupported provider: ${provider}`);
};

const isDebuggingTask = (ctx) => {
  const text = `${ctx.goal ?? ""} ${ctx.raw_intent ?? ""}`.toLowerCase();
  return /bug|error|crash|fix|debug|not working|failing|broken|exception|leak|slow|timeout|security|vulnerability|race|deadlock|performance/.test(text)
    || !!ctx.existing_context;
};

// ── Main pipeline ──────────────────────────────────────────────────────────────
// resume (optional): { clarificationAnswer } — set when this call is
// resuming after the user answered the real LLM's own clarifying question.
export const runPipeline = async (structuredContext, provider, apiKey, onStep, resume = null) => {

  // Simple-task bypass: non-debugging tasks skip the diagnostic framing
  // entirely and just get a direct, clean prompt.
  if (!resume && !isDebuggingTask(structuredContext)) {
    onStep({ type: "step", step: 1, total: 2, message: "Building prompt..." });
    const simplePrompt = `Task: ${structuredContext.goal ?? structuredContext.raw_intent}\n\n${
      structuredContext.constraints ? `Constraints: ${structuredContext.constraints}` : ""
    }`.trim();

    onStep({ type: "step", step: 2, total: 2, message: "Calling your LLM..." });
    const llmResponse = await callUserLLM(provider, apiKey, simplePrompt, "simple", onStep);
    const interpretation = await interpretResponse(
      llmResponse, { root_cause: structuredContext.goal, key_insight: null }, structuredContext, null, onStep
    );

    const result = {
      blocked: false, diagnoses: [], surgicalPrompt: simplePrompt,
      rawLLMResponse: llmResponse, interpretation, severity: "low", tokensSaved: 0,
    };
    onStep({ type: "done", message: "Done", data: result });
    return result;
  }

  // If resuming after a clarification answer, the answer is already folded
  // into structuredContext.existing_context by routes/pipeline.js — just
  // proceed as a normal fresh call with the enriched context.

  // Step 1: Groq lays out the context (cheap, fast — compression not judgment)
  onStep({ type: "step", step: 1, total: 4, message: "Laying out context..." });
  console.log("STRUCTURED CONTEXT AT DIAGNOSIS TIME:", JSON.stringify(structuredContext, null, 2));
  const { brief, distinct_issue_count, complexity } = await buildBrief(structuredContext, onStep);

  // Step 2: ONE call to the user's real LLM — diagnoses, fixes, self-critiques
  onStep({ type: "step", step: 2, total: 4, message: "Calling your LLM to diagnose and fix..." });
  const diagnosticPrompt = buildDiagnosticPrompt(brief, distinct_issue_count);
  const llmResponse = await callUserLLM(provider, apiKey, diagnosticPrompt, complexity, onStep);
// Check if the real LLM needs clarification instead of guessing.
// Works for any task type, not just debugging — the exact prefix is
// the strong signal; the fallback below catches genuine unlabeled
// questions across any prompt shape (models don't always comply with
// the literal prefix instruction).
const clarificationMatch = llmResponse.match(/NEEDS_CLARIFICATION:\s*([\s\S]*)/i);

const trimmed = llmResponse.trim();
const endsAsQuestion = /\?\s*$/.test(trimmed);
const isShortEnoughToBeAQuestion = trimmed.length < 600;
const hasNoCodeBlock = !/```/.test(trimmed);
const hasNoMultiParagraphStructure = trimmed.split(/\n{2,}/).length <= 2;

const looksLikeUnlabeledQuestion =
  endsAsQuestion && isShortEnoughToBeAQuestion && hasNoCodeBlock && hasNoMultiParagraphStructure;

if (clarificationMatch || looksLikeUnlabeledQuestion) {
  const question = clarificationMatch ? clarificationMatch[1].trim() : trimmed;
  const result = {
    blocked: true, reason: "needs_clarification",
    tieBreakQuestion: question || "Could you give more detail so I can proceed confidently?",
  };
  onStep({ type: "gate_blocked", message: "Your LLM needs more information before it can proceed confidently", data: result });
  return result;
}

  // Step 3: Deterministic npm check — the one fact-check worth keeping
  onStep({ type: "step", step: 3, total: 4, message: "Checking any package imports against npm..." });
  const verification = await verifyFix(llmResponse, structuredContext, onStep);

  // Step 4: Structure the response for the UI (cheap, fast — formatting not judgment)
  onStep({ type: "step", step: 4, total: 4, message: "Building your action plan..." });
  const interpretation = await interpretResponse(
    llmResponse,
    { root_cause: null, key_insight: null }, // diagnosis now lives inside llmResponse itself, interpreter extracts it from the text
    structuredContext, verification, onStep
  );

  const result = {
    blocked: false,
    rawLLMResponse: llmResponse,
    surgicalPrompt: diagnosticPrompt,
    verification,
    interpretation,
    severity: "medium",
    tokensSaved: estimateTokensSaved(structuredContext, diagnosticPrompt),
  };

  onStep({ type: "done", message: "Done", data: result });
  return result;
};

const estimateTokensSaved = (ctx, prompt) => {
  const rawLen      = (ctx.raw_intent ?? ctx.goal ?? "").length;
  const promptLen   = prompt.length;
  const naiveTokens = Math.ceil(rawLen / 4) * 5 * 3;
  const ourTokens   = Math.ceil(promptLen / 4);
  return Math.max(0, naiveTokens - ourTokens);
};