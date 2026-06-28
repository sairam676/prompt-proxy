/**
 * chat.js — main route orchestrator
 *
 * Flow:
 *   POST /start   → create session, first interview turn
 *   POST /reply   → continue interview
 *   POST /execute → classify + build + cache check + Claude call
 *   GET  /analytics/:sessionId
 */

import express from "express";
import { v4 as uuidv4 } from "uuid";

import { runInterviewTurn, forceExtractContext, MAX_TURNS } from "../middleware/interviewer.js";
import { buildOptimizedPrompt, buildSystemPrompt }          from "../middleware/promptBuilder.js";
import { classifyTask }                                      from "../middleware/taskClassifier.js";
import { tokenSavingsReport, enrichWithActual,
         countTokens, checkBudgetFit }                       from "../middleware/tokenEstimator.js";
import { callClaude }                                        from "../services/claude.js";
import { cacheGet, cacheSet, hashContext, logAnalytics,
         getAnalytics }                                      from "../cache/redis.js";
import { createSession, getSession,
         saveSession, isMaxTurnsReached }                    from "../services/sessionStore.js";

const router = express.Router();

// ── POST /api/chat/start ──────────────────────────────────────────────────────

router.post("/start", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim())
      return res.status(400).json({ error: "message is required" });

    const sessionId = uuidv4();
    const session   = await createSession(sessionId, message.trim());
    const result    = await runInterviewTurn(message, []);

    session.history    = result.history;
    session.turnCount  = 1;
    session.interviewerTokensUsed = (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);

    if (result.done) {
      session.status           = "complete";
      session.structuredContext = result.context;
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    await saveSession(sessionId, session);
    return res.json({
      sessionId,
      status:    "interviewing",
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
    if (!session) return res.status(404).json({ error: "Session not found or expired" });
    if (session.status === "complete")
      return res.status(400).json({ error: "Session already complete" });

    // Max turns hit — force extract and complete
    if (isMaxTurnsReached(session)) {
      const context = await forceExtractContext(session.history);
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
      (result.usage?.input_tokens ?? 0) +
      (result.usage?.output_tokens ?? 0);

    if (result.done) {
      session.status            = "complete";
      session.structuredContext = result.context;
      await saveSession(sessionId, session);
      return res.json({ sessionId, status: "complete" });
    }

    await saveSession(sessionId, session);
    return res.json({
      sessionId,
      status:    "interviewing",
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

router.post("/execute", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found or expired" });
    if (session.status !== "complete")
      return res.status(400).json({ error: "Interview not complete", status: session.status });

    const ctx = session.structuredContext;

    // ── 1. Classify task → get budget + dynamic max_tokens ──────────────────
    const classification = classifyTask(ctx);
    const { taskType, budget } = classification;

    // ── 2. Build optimized prompt ────────────────────────────────────────────
    const optimizedPrompt = buildOptimizedPrompt(ctx, taskType);
    const systemPrompt    = buildSystemPrompt(ctx, taskType);

    // ── 3. Pre-call token estimate ───────────────────────────────────────────
    const savings = tokenSavingsReport(session.rawIntent, optimizedPrompt, systemPrompt);

    // ── 4. Budget fit check (logs warnings, doesn't block) ──────────────────
    const promptTokens  = countTokens(optimizedPrompt);
    const systemTokens  = countTokens(systemPrompt);
    const budgetCheck   = checkBudgetFit(promptTokens, systemTokens, budget);
    if (budgetCheck.warnings.length > 0) {
      console.warn("[Budget]", budgetCheck.warnings);
    }

    // ── 5. Redis cache check (keyed on context hash) ─────────────────────────
    const contextHash = hashContext(ctx);
    const cached      = await cacheGet(contextHash);
    if (cached) {
      await logAnalytics(sessionId, {
        tokensSaved: cached.savings.tokensSaved ?? 0,
        tokensUsed:  0,
        cacheHit:    true,
      });
      return res.json({ ...cached, cacheHit: true });
    }

    // ── 6. Call Claude with dynamic max_tokens from budget template ───────────
    const claudeResult = await callClaude(systemPrompt, optimizedPrompt, {
      maxTokens: budget.maxOutputTokens,   // ← key: not hardcoded 1024
    });

    // ── 7. Enrich savings with actual token counts ────────────────────────────
    const finalSavings = enrichWithActual(savings, claudeResult.usage);

    const payload = {
      response:          claudeResult.text,
      optimizedPrompt,
      systemPrompt,
      structuredContext: ctx,
      taskType,
      classification:    { taskType, confidence: classification.confidence },
      savings:           finalSavings,
      budgetCheck:       { ...budgetCheck, maxOutputTokens: budget.maxOutputTokens },
      actualTokens: {
        input:  claudeResult.inputTokens,
        output: claudeResult.outputTokens,
        total:  claudeResult.totalTokens,
      },
      interviewerTokensUsed: session.interviewerTokensUsed ?? 0,
      model:    claudeResult.model,
      cacheHit: false,
    };

    // ── 8. Cache the result ───────────────────────────────────────────────────
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