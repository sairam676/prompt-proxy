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
import { callUserLLM, validateApiKey, PROVIDERS }            from "../services/byollm.js";
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
    const session   = await createSession(sessionId, message.trim());

    // Fast path: if input is already crystal clear, skip the interview entirely
    const extraction = extractUniversalContext(message.trim());
    session.extraction = extraction;

    if (extraction.skipInterview) {
      session.status            = "complete";
      session.structuredContext = buildContextFromExtraction(message.trim(), extraction);
      await saveSession(sessionId, session);
      return res.json({
        sessionId, status: "complete",
        fastPath: true,
        extraction: { type: extraction.detectedType, confidence: extraction.confidenceLevel },
      });
    }

    // Everything else — LLM interviewer generates smart dynamic questions
    // based on what THIS specific input actually needs. No hardcoded templates.
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
    return res.json({
      sessionId, status: "interviewing",
      question:  result.question,
      turnCount: session.turnCount,
      maxTurns:  MAX_TURNS,
    });
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
    if (!session)
      return res.status(404).json({ error: "Session not found or expired" });
    if (session.status === "complete")
      return res.status(400).json({ error: "Session already complete" });

    // Hit max turns — force extract whatever context we have and move on
    if (isMaxTurnsReached(session)) {
      const context = await forceExtractContext(session.history);
      session.structuredContext = context;
      session.status            = "complete";
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    // Continue the LLM interview — it decides what to ask next
    const result = await runInterviewTurn(message, session.history);
    session.history    = result.history;
    session.turnCount += 1;
    session.interviewerTokensUsed =
      (session.interviewerTokensUsed ?? 0) +
      (result.usage?.prompt_tokens    ?? 0) +
      (result.usage?.completion_tokens ?? 0);

    if (result.done) {
      session.status            = "complete";
      session.structuredContext = result.context;
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    await saveSession(sessionId, session);
    return res.json({
      sessionId, status: "interviewing",
      question:  result.question,
      turnCount: session.turnCount,
      maxTurns:  MAX_TURNS,
    });
  } catch (err) {
    console.error("[/reply]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat/execute ────────────────────────────────────────────────────
// mode: "server" (default, our Groq key)
//       "byollm"      (user's own Claude/OpenAI key)
//       "prompt_only" (just return the optimized prompt, user pastes it anywhere)
router.post("/execute", async (req, res) => {
  try {
    const { sessionId, byollm, mode, forceExecute } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const session = await getSession(sessionId);
    if (!session)
      return res.status(404).json({ error: "Session not found or expired" });
    if (session.status !== "complete")
      return res.status(400).json({ error: "Interview not complete", status: session.status });

    const ctx           = session.structuredContext;
    const executionMode = mode ?? (byollm?.apiKey ? "byollm" : "server");

    // 1. Classify task type
    const classification     = classifyTask(ctx);
    const { taskType, budget } = classification;

    // 2. Correctness check — block if critical facts are missing.
    //    This is the core product: we refuse to build a prompt that will
    //    hallucinate, regardless of which LLM it eventually runs on.
    const correctness = checkCorrectness(ctx, taskType);
    const hallRisk    = calculateHallucinationRisk(ctx, taskType, correctness.missingCritical);

    if (correctness.blocked && !forceExecute) {
      return res.json({
        sessionId,
        status:           "needs_critical_info",
        warningMessage:   correctness.warningMessage,
        missingFacts:     correctness.missingCritical.map(f => f.id),
        hallucinationRisk: hallRisk,
        canForceExecute:  true,
      });
    }

    // 3. Decision map — model routing + decomposition plan
    const decisionMap = buildDecisionMap(ctx, taskType);

    // 4. Build optimized prompt — this is the artifact we always produce,
    //    whether we execute it ourselves or hand it back to the user
    const optimizedPrompt = buildOptimizedPrompt(ctx, taskType);
    const systemPrompt    = buildSystemPrompt(ctx, taskType);

    // 5. Token savings estimate
    const savings = tokenSavingsReport(session.rawIntent, optimizedPrompt, systemPrompt);

    // 6. Budget fit check
    const promptTokens = countTokens(optimizedPrompt);
    const systemTokens = countTokens(systemPrompt);
    const budgetCheck  = checkBudgetFit(promptTokens, systemTokens, budget);
    if (budgetCheck.warnings.length > 0) console.warn("[Budget]", budgetCheck.warnings);

    // ── PROMPT-ONLY MODE ──────────────────────────────────────────────────────
    // User wants the optimized prompt to paste into their own LLM (Claude.ai,
    // ChatGPT, Cursor, etc). No LLM call from our side, no token cost.
    if (executionMode === "prompt_only") {
      return res.json({
        sessionId,
        mode:              "prompt_only",
        optimizedPrompt,
        systemPrompt,
        structuredContext: ctx,
        taskType,
        complexity:        ctx.complexity ?? "medium",
        savings,
        budgetCheck:       { ...budgetCheck, maxOutputTokens: budget.maxOutputTokens },
        hallucinationRisk: hallRisk,
        interviewerTokensUsed: session.interviewerTokensUsed ?? 0,
        suggestedModel:    decisionMap.model.id,
      });
    }

    // 7. Redis cache check
    const contextHash = hashContext(ctx);
    const cached      = await cacheGet(contextHash);
    if (cached) {
      await logAnalytics(sessionId, {
        tokensSaved: cached.savings?.tokensSaved ?? 0,
        tokensUsed:  0,
        cacheHit:    true,
      });
      return res.json({ ...cached, cacheHit: true });
    }

    // 8. Execute — user's own key (byollm) or our server-side Groq key
    let claudeResult;
    if (executionMode === "byollm") {
      if (!byollm?.apiKey || !byollm?.provider)
        return res.status(400).json({ error: "byollm.apiKey and byollm.provider required" });
      claudeResult = await callUserLLM(
        byollm.provider, byollm.apiKey, systemPrompt, optimizedPrompt,
        { model: byollm.model, maxTokens: budget.maxOutputTokens }
      );
    } else if (decisionMap.strategy === "decomposed" && decisionMap.subtasks) {
      claudeResult = await callClaudeDecomposed(systemPrompt, decisionMap.subtasks);
    } else {
      claudeResult = await callClaude(systemPrompt, optimizedPrompt, {
        model:     decisionMap.model.id,
        maxTokens: budget.maxOutputTokens,
      });
    }

    // 9. Enrich savings with actual token counts from provider
    const finalSavings = enrichWithActual(savings, claudeResult.usage);

    const payload = {
      response:          claudeResult.text,
      steps:             claudeResult.steps ?? null,
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
      hallucinationRisk:     hallRisk,
      model:    claudeResult.model ?? decisionMap.model.id,
      provider: claudeResult.provider ?? "groq",
      mode:     executionMode,
      cacheHit: false,
    };

    await cacheSet(contextHash, payload);
    await logAnalytics(sessionId, {
      tokensSaved: finalSavings.tokensSaved,
      tokensUsed:  claudeResult.totalTokens,
      cacheHit:    false,
    });

    return res.json(payload);
  } catch (err) {
    console.error("[/execute]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat/supplement ─────────────────────────────────────────────────
// User supplies a missing critical fact after correctness check blocked them.
// Merges into existing context and re-opens for execute.
router.post("/supplement", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message?.trim())
      return res.status(400).json({ error: "sessionId and message are required" });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found or expired" });

    const ctx       = session.structuredContext ?? {};
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

// ── GET /api/chat/providers ───────────────────────────────────────────────────
router.get("/providers", (req, res) => {
  return res.json(PROVIDERS);
});

// ── POST /api/chat/validate-key ───────────────────────────────────────────────
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

// ── GET /api/chat/analytics/:sessionId ───────────────────────────────────────
router.get("/analytics/:sessionId", async (req, res) => {
  try {
    const stats = await getAnalytics(req.params.sessionId);
    return res.json(stats ?? {});
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;