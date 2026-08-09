/**
 * runner.js
 *
 * See extractor.js for the full reasoning behind the redesign.
 *
 * Flow:
 * 1. Groq lays out the user's context into one clean brief, and classifies
 *    mechanical complexity (simple/medium/complex) — a classification, not
 *    a diagnosis.
 * 2. ONE call to the user's real LLM:
 *    - "simple" bugs get a lightweight prompt — direct diagnose + fix, no
 *      evidence/confidence scaffolding.
 *    - "medium"/"complex" bugs get the full evidence/assumption/confidence
 *      prompt — the real LLM separates what it directly observed from what
 *      it's inferring, self-reports confidence, lists alternatives, and
 *      self-critiques the fix (including stating its own runtime-scope
 *      assumptions explicitly).
 *    - If the session has an uploaded project (zip), the Gemini path routes
 *      through an agentic tool-use loop (read_file/list_files) instead of a
 *      plain one-shot call — the real LLM decides what to read, never the
 *      cheap Groq model. Currently Gemini-only; other providers still get
 *      the plain one-shot call even with files attached.
 *    Either way, if it's not confident, IT says so and asks a specific
 *    question, instead of a weak model guessing on its behalf.
 * 3. Deterministic verification: syntax check, npm registry check, and
 *    directional-intent contradiction check (fail-open/closed style
 *    mismatches between what was asked and what the fix's config does).
 * 4. Auto-repair: a rejected fix gets one automatic re-call to the same LLM
 *    with the exact failure detail, before the user ever sees it.
 * 5. Groq structures the final response into the UI's action-plan shape.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI    from "openai";
import Groq      from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { buildBrief, buildDiagnosticPrompt, buildSimpleDiagnosticPrompt, buildRepairPrompt } from "./extractor.js";
import { verifyFix }         from "./fixVerifier.js";
import { interpretResponse } from "./interpreter.js";
import { readSessionFile, listFiles } from "./fileContext.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MAX_REPAIR_ATTEMPTS = 1; // one automatic re-call on a rejected fix, capped for cost predictability
const MAX_TOOL_TURNS = 5;      // cap on agentic read_file/list_files round-trips per diagnostic call

// ── Gemini tool-use (agentic slice) ─────────────────────────────────────────
const READ_FILE_TOOL = {
  functionDeclarations: [{
    name: "read_file",
    description: "Read the contents of a file from the user's uploaded project.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file, from the list_files result." },
      },
      required: ["path"],
    },
  }, {
    name: "list_files",
    description: "List all files available in the user's uploaded project.",
    parameters: { type: "object", properties: {} },
  }],
};

const callGeminiWithTools = async (apiKey, promptText, sessionId, complexity, onStep) => {
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = complexity === "complex" ? "gemini-pro-latest" : "gemini-flash-latest";
  const model = genAI.getGenerativeModel({ model: modelName, tools: [READ_FILE_TOOL] });

  const chat = model.startChat();
  let response = await chat.sendMessage(promptText);
  let turns = 0;

  while (turns < MAX_TOOL_TURNS) {
    const functionCalls = response.response.functionCalls();
    if (!functionCalls || functionCalls.length === 0) break;

    turns += 1;
    const call = functionCalls[0];
    onStep({ type: "tool_call", message: `Reading ${call.args?.path ?? "file list"}...`, data: call });

    let toolResult;
    if (call.name === "read_file") {
      toolResult = readSessionFile(sessionId, call.args.path);
    } else if (call.name === "list_files") {
      toolResult = { files: listFiles(sessionId) };
    } else {
      toolResult = { error: `Unknown tool: ${call.name}` };
    }

    response = await chat.sendMessage([{
      functionResponse: { name: call.name, response: toolResult },
    }]);
  }

  const usage = response.response.usageMetadata;
  onStep({
    type: "llm_done", message: "Response received",
    data: {
      inputTokens: usage?.promptTokenCount ?? null,
      outputTokens: usage?.candidatesTokenCount ?? null,
      model: modelName,
      toolTurns: turns,
    },
  });

  return response.response.text();
};

// ── Call user's LLM ─────────────────────────────────────────────────────────
const callUserLLM = async (provider, apiKey, promptText, complexity, sessionId, onStep) => {
  onStep({
    type:    "status",
    message: `Sending to your ${
      provider === "claude" ? "Claude" : provider === "groq" ? "Groq" : provider === "gemini" ? "Gemini" : "OpenAI"
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

  if (provider === "gemini") {
    // If the session has an uploaded project (zip), route through the
    // agentic tool-use path instead of a plain one-shot call. The real
    // Gemini model decides what to read — never the cheap Groq model.
     const filesForSession = sessionId ? listFiles(sessionId) : [];
    console.log("[callUserLLM/gemini] sessionId at diagnosis:", sessionId, "| files found:", filesForSession);
    if (sessionId && listFiles(sessionId).length > 0) {
      return await callGeminiWithTools(apiKey, promptText, sessionId, complexity, onStep);
    }

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

/**
 * needsVerification — decides whether the verification/auto-repair loop
 * should run. Only useful for responses that contain code fixes — running
 * syntax checks on a conceptual explanation is pure noise.
 */
const needsVerification = (ctx) => {
  return isDebuggingTask(ctx);
};

/**
 * detectClarificationRequest — checks whether the real LLM's response is
 * asking for more information instead of proceeding on a guess. Two paths:
 * (1) it used the exact "NEEDS_CLARIFICATION:" prefix we asked for, or
 * (2) it asked a genuine unlabeled question — models don't always comply
 * with the literal prefix instruction, so a task-agnostic fallback catches
 * short, question-ending, unstructured responses regardless of task type.
 */
const detectClarificationRequest = (llmResponse) => {
  const clarificationMatch = llmResponse.match(/NEEDS_CLARIFICATION:\s*([\s\S]*)/i);
  if (clarificationMatch) {
    return clarificationMatch[1].trim() || "Could you give more detail so I can proceed confidently?";
  }

  const trimmed = llmResponse.trim();
  const endsAsQuestion = /\?\s*$/.test(trimmed);
  const isShortEnoughToBeAQuestion = trimmed.length < 600;
  const hasNoCodeBlock = !/```/.test(trimmed);
  const hasNoMultiParagraphStructure = trimmed.split(/\n{2,}/).length <= 2;

  const looksLikeUnlabeledQuestion =
    endsAsQuestion && isShortEnoughToBeAQuestion && hasNoCodeBlock && hasNoMultiParagraphStructure;

  return looksLikeUnlabeledQuestion ? trimmed : null;
};

// ── Main pipeline ──────────────────────────────────────────────────────────────
// sessionId is threaded through so the Gemini tool-use path can look up
// uploaded files for this specific session.
export const runPipeline = async (structuredContext, provider, apiKey, sessionId, onStep, resume = null) => {

  // Step 1: Groq lays out the context into a clean brief — runs for ALL
  // tasks, not just debugging. This is where the middle LLM adds value:
  // compressing, structuring, and classifying complexity so the user's
  // main LLM gets a tight, complete prompt instead of raw unstructured text.
  onStep({ type: "step", step: 1, total: needsVerification(structuredContext) ? 4 : 3, message: "Laying out context..." });
  console.log("STRUCTURED CONTEXT AT DIAGNOSIS TIME:", JSON.stringify(structuredContext, null, 2));
  const { brief, distinct_issue_count, complexity } = await buildBrief(structuredContext, onStep);

  // Step 2: ONE call to the user's real LLM
  const totalSteps = needsVerification(structuredContext) ? 4 : 3;
  onStep({ type: "step", step: 2, total: totalSteps, message: isDebuggingTask(structuredContext) ? "Calling your LLM to diagnose and fix..." : "Calling your LLM..." });

  const diagnosticPrompt = isDebuggingTask(structuredContext)
    ? (complexity === "simple"
        ? buildSimpleDiagnosticPrompt(brief)
        : buildDiagnosticPrompt(brief, distinct_issue_count))
    : brief; // Non-debug tasks: the brief IS the prompt — already compressed and structured

  const llmResponse = await callUserLLM(provider, apiKey, diagnosticPrompt, complexity, sessionId, onStep);

  // Check if the real LLM needs clarification instead of guessing
  const clarificationQuestion = detectClarificationRequest(llmResponse);
  if (clarificationQuestion) {
    const result = {
      blocked: true, reason: "needs_clarification",
      tieBreakQuestion: clarificationQuestion,
    };
    onStep({ type: "gate_blocked", message: "Your LLM needs more information before it can proceed confidently", data: result });
    return result;
  }

  // Step 3 (debug tasks): Deterministic verification — syntax, npm, and directional intent
  // Step 3 (non-debug tasks): Skip verification, go straight to interpretation
  let verification = null;
  let finalResponse = llmResponse;
  let repairAttempts = 0;

  if (needsVerification(structuredContext)) {
    onStep({ type: "step", step: 3, total: 4, message: "Checking code syntax, package imports, and stated intent..." });
    verification = await verifyFix(llmResponse, structuredContext, onStep);

    // Auto-repair loop: if verification found a real, specific problem, feed
    // it back to the SAME LLM once and let it self-correct with actual error
    // detail — rather than showing the user a rejected fix it never got a
    // chance to revise.
    while (verification.status === "rejected" && repairAttempts < MAX_REPAIR_ATTEMPTS) {
      repairAttempts += 1;
      onStep({
        type: "repair_attempt",
        message: `Fix had an issue — asking your LLM to correct it (attempt ${repairAttempts})...`,
        data: { issues: verification.issues },
      });

      const repairPrompt = buildRepairPrompt(finalResponse, verification.issues);
      finalResponse = await callUserLLM(provider, apiKey, repairPrompt, complexity, sessionId, onStep);
      verification = await verifyFix(finalResponse, structuredContext, onStep);
    }
  }

  // Final step: Structure the response for the UI (cheap, fast — formatting not judgment)
  const stepNum = needsVerification(structuredContext) ? 4 : 3;
  onStep({ type: "step", step: stepNum, total: totalSteps, message: "Building your action plan..." });
  const interpretation = await interpretResponse(
    finalResponse,
    { root_cause: null, key_insight: null },
    structuredContext, verification, onStep
  );

  const result = {
    blocked: false,
    rawLLMResponse: finalResponse,
    surgicalPrompt: diagnosticPrompt,
    verification,
    interpretation,
    repairAttempts,
    severity: complexity === "simple" ? "low" : "medium",
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