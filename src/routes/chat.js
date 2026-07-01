import express from "express";
import { v4 as uuidv4 } from "uuid";

import { runInterviewTurn, forceExtractContext, MAX_TURNS } from "../middleware/interviewer.js";
import { buildOptimizedPrompt, buildSystemPrompt }          from "../middleware/promptBuilder.js";
import { classifyTask }                                      from "../middleware/taskClassifier.js";
import { buildDecisionMap }                                  from "../middleware/decisionMap.js";
import { extractUniversalContext, buildContextFromExtraction } from "../middleware/universalExtractor.js";
import { checkCorrectness, calculateHallucinationRisk }      from "../middleware/correctnessLayer.js";
import { tokenSavingsReport, enrichWithActual,
         countTokens, checkBudgetFit }                       from "../middleware/tokenEstimator.js";
import { callClaude, callClaudeDecomposed }                  from "../services/claude.js";
import { callUserLLM, validateApiKey, PROVIDERS }             from "../services/byollm.js";
import { cacheGet, cacheSet, hashContext,
         logAnalytics, getAnalytics }                        from "../cache/redis.js";
import { createSession, getSession,
         saveSession, isMaxTurnsReached }                    from "../services/sessionStore.js";

const router = express.Router();

// ── POST /api/chat/start ──────────────────────────────────────────────────────
router.post("/start", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message is required" });

    const sessionId = uuidv4();
    const session    = await createSession(sessionId, message.trim());

    // ── Fast path: universal extraction (no LLM call needed) ─────────────────
    const extraction = extractUniversalContext(message.trim());
    session.extraction = extraction;

    if (extraction.skipInterview) {
      // High confidence — bypass LLM interviewer entirely, straight to execute
      session.status            = "complete";
      session.structuredContext = buildContextFromExtraction(message.trim(), extraction);
      await saveSession(sessionId, session);
      return res.json({
        sessionId, status: "complete",
        fastPath: true,
        extraction: { type: extraction.detectedType, confidence: extraction.confidenceLevel },
      });
    }

    if (extraction.needsOneQuestion && extraction.suggestedQuestion) {
      // One confirming question only — no need for full LLM interview loop
      session.history         = [{ role: "user", content: message }];
      session.turnCount       = 1;
      session.fastPathPending = true;
      await saveSession(sessionId, session);
      return res.json({
        sessionId, status: "interviewing",
        question: extraction.suggestedQuestion,
        turnCount: 1, maxTurns: MAX_TURNS,
        fastPath: true,
      });
    }

    // ── Standard path: full LLM interviewer (low confidence input) ────────────
    const result = await runInterviewTurn(message, []);

    session.history   = result.history;
    session.turnCount = 1;
    session.interviewerTokensUsed = (result.usage?.prompt_tokens ?? 0) +
                                    (result.usage?.completion_tokens ?? 0);

    if (result.done) {
      session.status            = "complete";
      session.structuredContext = result.context;
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    await saveSession(sessionId, session);
    return res.json({ sessionId, status: "interviewing",
                      question: result.question, turnCount: session.turnCount, maxTurns: MAX_TURNS });
  } catch (err) {
    console.error("[/start]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat/reply ──────────────────────────────────────────────────────
router.post("/reply", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message?.trim())
      return res.status(400).json({ error: "sessionId and message are required" });

    const session = await getSession(sessionId);
    if (!session)               return res.status(404).json({ error: "Session not found or expired" });
    if (session.status === "complete")
      return res.status(400).json({ error: "Session already complete" });

    if (isMaxTurnsReached(session)) {
      const context = await forceExtractContext(session.history);
      session.structuredContext = context;
      session.status            = "complete";
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    // ── Fast path follow-up: merge answer directly, skip LLM interviewer ──────
    if (session.fastPathPending) {
      const originalMessage = session.history[0]?.content ?? session.rawIntent;
      const combined = `${originalMessage}\n\nAdditional context: ${message}`;
      const context = buildContextFromExtraction(combined, session.extraction ?? {});
      // Merge in the user's clarifying answer as extra constraint/goal detail
      context.constraints = context.constraints
        ? `${context.constraints}; ${message}` : message;

      session.structuredContext = context;
      session.status            = "complete";
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    const result = await runInterviewTurn(message, session.history);
    session.history    = result.history;
    session.turnCount += 1;
    session.interviewerTokensUsed =
      (session.interviewerTokensUsed ?? 0) +
      (result.usage?.prompt_tokens  ?? 0)  +
      (result.usage?.completion_tokens ?? 0);

    if (result.done) {
      session.status            = "complete";
      session.structuredContext = result.context;
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    await saveSession(sessionId, session);
    return res.json({ sessionId, status: "interviewing",
                      question: result.question, turnCount: session.turnCount, maxTurns: MAX_TURNS });
  } catch (err) {
    console.error("[/reply]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat/execute ────────────────────────────────────────────────────
router.post("/execute", async (req, res) => {
  try {
    const { sessionId, byollm, mode } = req.body;
    // mode: "server" (default, uses our Groq key) | "byollm" (user's own key) | "prompt_only" (just return the prompt, don't call any LLM)
    // byollm (required if mode === "byollm"): { provider: "claude"|"openai", apiKey: "...", model: "..." }
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found or expired" });
    if (session.status !== "complete")
      return res.status(400).json({ error: "Interview not complete", status: session.status });

    const ctx = session.structuredContext;
    const executionMode = mode ?? (byollm?.apiKey ? "byollm" : "server");

    // 1. Classify task
    const classification  = classifyTask(ctx);
    const { taskType, budget } = classification;

    // 1.5. CORRECTNESS CHECK — this is the core product.
    // Block prompt generation if critical facts are missing that would cause
    // hallucinated/wrong output. We never even build the prompt in this case —
    // there's no point optimizing a prompt that's missing the one thing that
    // matters, regardless of which LLM it eventually goes to.
    const correctness  = checkCorrectness(ctx, taskType);
    const hallRisk      = calculateHallucinationRisk(ctx, taskType, correctness.missingCritical);

    if (correctness.blocked && !req.body.forceExecute) {
      return res.json({
        sessionId,
        status: "needs_critical_info",
        warningMessage: correctness.warningMessage,
        missingFacts: correctness.missingCritical.map(f => f.id),
        hallucinationRisk: hallRisk,
        canForceExecute: true,
      });
    }

    // 2. Build decision map — model routing + decomposition plan (server mode only)
    const decisionMap = buildDecisionMap(ctx, taskType);

    // 3. ALWAYS build the optimized prompt — this is the deliverable regardless
    //    of where it ends up running. Our Groq-backed interviewer did the work
    //    of extracting context; this step turns that into the final artifact.
    const optimizedPrompt = buildOptimizedPrompt(ctx, taskType);
    const systemPrompt    = buildSystemPrompt(ctx, taskType);

    // 4. Token estimate — useful even if the user copies the prompt elsewhere,
    //    since it shows them what they'd have spent on a naive prompt instead
    const savings = tokenSavingsReport(session.rawIntent, optimizedPrompt, systemPrompt);

    // 5. Budget check
    const promptTokens = countTokens(optimizedPrompt);
    const systemTokens = countTokens(systemPrompt);
    const budgetCheck  = checkBudgetFit(promptTokens, systemTokens, budget);
    if (budgetCheck.warnings.length > 0) console.warn("[Budget]", budgetCheck.warnings);

    // ── PROMPT-ONLY MODE: stop here, return the prompt for copy-paste ────────
    // No LLM call, no cache write, no token cost beyond the interview itself.
    // This is the path for "I'll paste this into ChatGPT / claude.ai / Cursor myself".
    if (executionMode === "prompt_only") {
      return res.json({
        sessionId,
        mode: "prompt_only",
        optimizedPrompt,
        systemPrompt,
        structuredContext: ctx,
        taskType,
        complexity: ctx.complexity ?? "medium",
        savings,
        budgetCheck: { ...budgetCheck, maxOutputTokens: budget.maxOutputTokens },
        hallucinationRisk: hallRisk,
        interviewerTokensUsed: session.interviewerTokensUsed ?? 0,
        suggestedModel: decisionMap.model.id,
      });
    }

    // 6. Redis cache check (only relevant for actual execution, not prompt_only)
    const contextHash = hashContext(ctx);
    const cached      = await cacheGet(contextHash);
    if (cached) {
      await logAnalytics(sessionId, { tokensSaved: cached.savings?.tokensSaved ?? 0,
                                      tokensUsed: 0, cacheHit: true });
      return res.json({ ...cached, cacheHit: true });
    }

    // 7. Execute — BYOLLM (user's own key) or our server-side Groq key.
    //    Either way, the prompt built above is identical — only WHO runs it differs.
    let claudeResult;
    if (executionMode === "byollm") {
      if (!byollm?.apiKey || !byollm?.provider) {
        return res.status(400).json({ error: "byollm.apiKey and byollm.provider are required for byollm mode" });
      }
      // User's own account, user's own credits — we never see or store the key beyond this call
      claudeResult = await callUserLLM(byollm.provider, byollm.apiKey, systemPrompt, optimizedPrompt, {
        model:     byollm.model,
        maxTokens: budget.maxOutputTokens,
      });
    } else if (decisionMap.strategy === "decomposed" && decisionMap.subtasks) {
      claudeResult = await callClaudeDecomposed(systemPrompt, decisionMap.subtasks);
    } else {
      claudeResult = await callClaude(systemPrompt, optimizedPrompt, {
        model:     decisionMap.model.id,
        maxTokens: budget.maxOutputTokens,
      });
    }

    // 8. Enrich savings with actual token counts
    const finalSavings = enrichWithActual(savings, claudeResult.usage);

    const payload = {
      response:          claudeResult.text,
      steps:             claudeResult.steps ?? null,   // subtask chain for complex tasks
      optimizedPrompt,
      systemPrompt,
      structuredContext: ctx,
      taskType,
      complexity:        ctx.complexity ?? "medium",
      strategy:          decisionMap.strategy,
      decisionReasoning: decisionMap.reasoning,
      classification:    { taskType, confidence: classification.confidence },
      savings:           finalSavings,
      budgetCheck:       { ...budgetCheck, maxOutputTokens: budget.maxOutputTokens },
      actualTokens: {
        input:  claudeResult.inputTokens,
        output: claudeResult.outputTokens,
        total:  claudeResult.totalTokens,
      },
      interviewerTokensUsed: session.interviewerTokensUsed ?? 0,
      hallucinationRisk: hallRisk,
      model:    claudeResult.model ?? decisionMap.model.id,
      provider: claudeResult.provider ?? "groq",
      mode:     executionMode,
      cacheHit: false,
    };

    await cacheSet(contextHash, payload);
    await logAnalytics(sessionId, { tokensSaved: finalSavings.tokensSaved,
                                    tokensUsed: claudeResult.totalTokens, cacheHit: false });

    return res.json(payload);
  } catch (err) {
    console.error("[/execute]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chat/analytics/:sessionId ───────────────────────────────────────
// ── GET /api/chat/providers ───────────────────────────────────────────────────
// List supported LLM providers and their models for the connect-account UI
// ── POST /api/chat/supplement ──────────────────────────────────────────────────
// Used when execute returned needs_critical_info. User supplies the missing
// fact, we merge it into context and retry — without re-running the full
// interview loop or losing what was already established.
router.post("/supplement", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message?.trim())
      return res.status(400).json({ error: "sessionId and message are required" });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found or expired" });

    // Merge the supplied fact into existing context as additional constraints/goal detail
    const ctx = session.structuredContext ?? {};
    ctx.constraints = ctx.constraints ? `${ctx.constraints}\n${message}` : message;
    ctx.raw_intent  = `${ctx.raw_intent ?? ""}\n\n${message}`;

    session.structuredContext = ctx;
    session.status            = "complete";
    await saveSession(sessionId, session);

    return res.json({ sessionId, status: "complete" });
  } catch (err) {
    console.error("[/supplement]", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/providers", (req, res) => {
  return res.json(PROVIDERS);
});

// ── POST /api/chat/validate-key ───────────────────────────────────────────────
// Quick check that a user's API key works before they rely on it
router.post("/validate-key", async (req, res) => {
  try {
    const { provider, apiKey } = req.body;
    if (!provider || !apiKey)
      return res.status(400).json({ error: "provider and apiKey are required" });

    const result = await validateApiKey(provider, apiKey);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/analytics/:sessionId", async (req, res) => {
  try {
    const stats = await getAnalytics(req.params.sessionId);
    return res.json(stats ?? {});
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;