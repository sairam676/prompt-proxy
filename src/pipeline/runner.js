/**
 * runner.js
 * 
 * Orchestrates the full pipeline:
 * 1. Hypothesis Engine — generate competing hypotheses (our Groq — free, fast)
 * 1b. Sufficiency Gate — only proceed if one hypothesis clearly wins
 * 2. Build surgical prompt from the CONFIRMED diagnosis (our Groq — free, fast)
 * 3. Call user's LLM with the surgical prompt (their key — their credits, one call)
 * 4. Verify the fix before showing it (our Groq — free, fast)
 * 5. Interpret response into complete, relevance-constrained action output (our Groq)
 * 
 * Latency optimizations:
 * - Groq for steps 1, 2, 4, 5 (fastest inference available)
 * - Right model size: 8B for simple tasks/verification, 70B for complex reasoning
 * - Stream output tokens live so user sees progress immediately
 * - No max_tokens truncation — complete information always
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI    from "openai";
import Groq      from "groq-sdk";
import { extractAndAnalyze, buildSurgicalPrompt, rescoreHypotheses } from "./extractor.js";
import { isSufficient, mergeHypotheses } from "./sufficiencyGate.js";
import { verifyFix }     from "./fixVerifier.js";
import { interpretResponse } from "./interpreter.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Call user's LLM with the surgical prompt ───────────────────────────────────
const callUserLLM = async (provider, apiKey, surgicalPrompt, complexity, onStep) => {
  onStep({
    type:    "status",
    message: `Sending to your ${
  provider  === "claude" ? "Claude" :
  provider === "groq"   ? "Groq" : "OpenAI"
} account...`,
  });

  const promptText = typeof surgicalPrompt === "string"
    ? surgicalPrompt
    : surgicalPrompt?.task
      ? `Task: ${surgicalPrompt.task}\n\nContext:\n${surgicalPrompt.context ?? ""}${
          surgicalPrompt.constraints ? `\n\nConstraints: ${surgicalPrompt.constraints}` : ""
        }${
          surgicalPrompt.already_tried ? `\n\nAlready tried: ${surgicalPrompt.already_tried}` : ""
        }${
          surgicalPrompt.expected ? `\n\nExpected: ${surgicalPrompt.expected}` : ""
        }\n\nReturn format: ${surgicalPrompt.return_format ?? ""}`
      : JSON.stringify(surgicalPrompt);

  const systemPrompt = `You are an expert. Respond completely and precisely. 
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
      type:    "llm_done",
      message: "Response received",
      data: {
        inputTokens:  response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model:        response.model,
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

  if (provider === "groq") {
    const model = complexity === "complex"
      ? "llama-3.3-70b-versatile"
      : "llama-3.1-8b-instant";
    const response = await groq.chat.completions.create({
      model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: promptText },
      ],
    });
    const text = response.choices[0].message.content;
    onStep({
      type: "llm_done", message: "Response received",
      data: {
        inputTokens:  response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        model:        response.model,
      },
    });
    return text;
  }

  throw new Error(`Unsupported provider: ${provider}`);
};

// ── Main pipeline ──────────────────────────────────────────────────────────────
// resume (optional): { analysis, competingIds, newAnswer } — set when this call
// is resuming after a tie-break answer, so we skip full re-generation and only
// re-score the two hypotheses that were competing.
export const runPipeline = async (structuredContext, provider, apiKey, onStep, resume = null) => {

  let analysis;

  if (resume?.analysis && resume?.competingIds?.length && resume?.newAnswer) {
    // Step 1 (resumed): re-score only the previously-competing pair — cheap, targeted
    onStep({ type: "step", step: 1, total: 5, message: "Re-scoring hypotheses with your answer..." });
    const competing = resume.analysis.hypotheses.filter(h => resume.competingIds.includes(h.id));
    const rescored  = await rescoreHypotheses(competing, resume.newAnswer, structuredContext, onStep);
    analysis = {
      ...resume.analysis,
      hypotheses: mergeHypotheses(resume.analysis.hypotheses, rescored),
    };
  } else {
    // Step 1 (fresh): Hypothesis Engine — our Groq, free
    onStep({ type: "step", step: 1, total: 5, message: "Generating competing hypotheses..." });
    analysis = await extractAndAnalyze(structuredContext, onStep);
  }

  // Step 1b: Sufficiency Gate
  const gate = isSufficient(analysis.hypotheses);
  if (!gate.sufficient) {
    // Not confident enough to proceed — hand a targeted question back to the
    // caller instead of guessing, along with enough state (analysis + which
    // ids are competing) to resume with a targeted re-score next turn instead
    // of starting over. The caller (routes/pipeline.js) is expected to route
    // this back into the interview loop rather than calling the user's LLM.
    const result = {
      blocked:          true,
      reason:           "insufficient_evidence",
      hypotheses:       analysis.hypotheses,
      analysis,
      competingIds:     gate.competingIds,
      tieBreakQuestion: gate.tieBreakQuestion,
    };
    onStep({ type: "gate_blocked", message: "Insufficient evidence to isolate cause", data: result });
    return result;
  }

  const diagnosis = gate.diagnosis;
  onStep({ type: "diagnosis", message: "Diagnosis confirmed", data: diagnosis });

  // Step 2: Build surgical prompt from the CONFIRMED diagnosis — our Groq, free
  onStep({ type: "step", step: 2, total: 5, message: "Building surgical prompt..." });
  const surgicalPrompt = await buildSurgicalPrompt(diagnosis, structuredContext, onStep);

  // Step 3: Call their LLM once with surgical prompt — their credits
  onStep({ type: "step", step: 3, total: 5, message: "Calling your LLM with surgical prompt..." });
  const llmResponse = await callUserLLM(
    provider, apiKey,
    surgicalPrompt,
    analysis.complexity,
    onStep
  );

  // Step 4: Verify the fix before showing it — our Groq, free
  onStep({ type: "step", step: 4, total: 5, message: "Verifying fix..." });
  const verification = await verifyFix(llmResponse, structuredContext, onStep);

  // Step 5: Interpret — our Groq, free
  onStep({ type: "step", step: 5, total: 5, message: "Building your action plan..." });
  const analysisForInterpreter = { root_cause: diagnosis.theory, key_insight: analysis.key_insight };
  const interpretation = await interpretResponse(
    llmResponse, analysisForInterpreter, structuredContext, verification, onStep
  );

  const result = {
    blocked:        false,
    diagnosis,
    hypotheses:     analysis.hypotheses,
    problemArea:    analysis.problem_area,
    severity:       analysis.severity,
    keyInsight:     analysis.key_insight,
    surgicalPrompt,
    rawLLMResponse: llmResponse,
    verification,
    interpretation,
    tokensSaved:    estimateTokensSaved(structuredContext, surgicalPrompt),
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
  const naiveTokens = Math.ceil(rawLen / 4) * 5 * 3;
  const ourTokens   = Math.ceil(promptLen / 4);
  return Math.max(0, naiveTokens - ourTokens);
};